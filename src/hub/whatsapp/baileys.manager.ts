import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../database/db.ts';
import { schemaEngine } from '../../records/schema.engine.ts';
import { geminiService } from '../ai/gemini.service.ts';
import { webhookDispatcher } from '../webhooks/webhook.dispatcher.ts';

export interface SendMessageOptions {
  instanceId: string;
  toPhone: string;
  remoteJid?: string;
  text: string;
}

export interface IWhatsAppProvider {
  startSession(instanceId: string): Promise<{ status: string; qrCodeBase64?: string | null }>;
  stopSession(instanceId: string, logout?: boolean): Promise<void>;
  deleteSession(instanceId: string): Promise<void>;
  autoStartSavedSessions(): Promise<void>;
  resumeUnansweredAllowedChats(instanceId: string): Promise<void>;
  sendTextMessage(options: SendMessageOptions): Promise<{ messageId: string; delivered: boolean }>;
}

// Conversas autorizadas do Modo Teste Seguro (Amor Gatosa e Ricardo Messias Batista)
export const ALLOWED_TEST_JIDS = new Set<string>([
  '237327075004656@lid',
  '149091233304709@lid',
]);

class BaileysMultiSessionManager implements IWhatsAppProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sockets = new Map<string, any>();
  private stoppedOrDeletedInstances = new Set<string>();
  private botSentMessageIds = new Set<string>();
  private processedIncomingMsgIds = new Set<string>();
  private lastKnownJidByPhone = new Map<string, string>();
  private lastSentTimeByJid = new Map<string, number>();
  private lastSentContentByJid = new Map<string, string>();
  private pendingTextBuffers = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      texts: string[];
      baseParams: {
        instanceId: string;
        remoteJid: string;
        senderPhone: string;
        pushName: string;
      };
    }
  >();

  private readonly botReplySignatures = [
    'Aqui na *ADEN Massoterapia* trabalhamos',
    'Qual técnica você gostaria de agendar?',
    'Me conta uma coisa pra eu já ir preparando',
    'Claro, vamos combinar sim!',
    'Entendi! Tem alguma alergia',
    'Entendi! E você tem alergia',
    'Combinado. E existe alguma condição de saúde',
    'Combinado. Você está gestante',
    'E pra fechar: você tem pressão alta',
    'Maravilha, já deixei tudo certinho aqui',
    'Perfeito, já deixei seu horário pré-reservado',
    'Perfeito, ',
    'Olá, ',
    '💆‍♀️ *Serviço Cadastrado',
    '💆‍♀️ *Catálogo de Serviços',
    '🔔 *Nova ',
    '🎙️ *Evolução registrada',
    '🎙️ *Pós-Atendimento Registrado',
    '🔍 Nenhum cadastro',
    '📋 *Ficha ',
    '🚨 *Alerta de Pós-Atendimento',
    '🔄 *Ficha reiniciada',
    '🗓️ *Atendimentos e Pré-Agendamentos',
    '✅ *Sinal Confirmado e Agendamento',
    '✅ *Pagamento do sinal confirmado',
  ];

  public getAllowedJids(): string[] {
    return Array.from(ALLOWED_TEST_JIDS);
  }

  public addAllowedJid(jid: string): void {
    if (jid && jid.trim()) {
      ALLOWED_TEST_JIDS.add(jid.trim());
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unwrapBaileysMessage(message: any): any {
    if (!message || typeof message !== 'object') return null;
    if (message.ephemeralMessage?.message) {
      return this.unwrapBaileysMessage(message.ephemeralMessage.message);
    }
    if (message.viewOnceMessage?.message) {
      return this.unwrapBaileysMessage(message.viewOnceMessage.message);
    }
    if (message.viewOnceMessageV2?.message) {
      return this.unwrapBaileysMessage(message.viewOnceMessageV2.message);
    }
    if (message.viewOnceMessageV2Extension?.message) {
      return this.unwrapBaileysMessage(message.viewOnceMessageV2Extension.message);
    }
    if (message.deviceSentMessage?.message) {
      return this.unwrapBaileysMessage(message.deviceSentMessage.message);
    }
    if (message.editedMessage?.message?.protocolMessage?.editedMessage) {
      return this.unwrapBaileysMessage(message.editedMessage.message.protocolMessage.editedMessage);
    }
    if (message.editedMessage?.message) {
      return this.unwrapBaileysMessage(message.editedMessage.message);
    }
    if (message.documentWithCaptionMessage?.message) {
      return this.unwrapBaileysMessage(message.documentWithCaptionMessage.message);
    }
    return message;
  }

  private normalizeNameForMatch(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/jh/g, 'j')
      .replace(/ph/g, 'f')
      .replace(/y/g, 'i')
      .replace(/w/g, 'v')
      .replace(/([a-z])\1+/g, '$1')
      .replace(/[^a-z0-9]/g, '');
  }

  private isContactAllowedByFilter(
    remoteJid: string,
    incomingPushName: string,
    allowedList: Iterable<string>
  ): boolean {
    const cleanRemotePrefix = remoteJid.split('@')[0].split(':')[0].toLowerCase();
    const normPush = this.normalizeNameForMatch(incomingPushName);

    for (const rawAllowed of allowedList) {
      const allowed = rawAllowed.trim();
      if (!allowed) continue;
      if (remoteJid === allowed) return true;
      const cleanAllowedPrefix = allowed.split('@')[0].split(':')[0].toLowerCase();
      if (cleanAllowedPrefix && cleanRemotePrefix === cleanAllowedPrefix) return true;
      if (
        incomingPushName &&
        incomingPushName.toLowerCase().includes(allowed.toLowerCase())
      ) {
        return true;
      }
      const normAllowed = this.normalizeNameForMatch(allowed);
      if (normAllowed.length >= 3 && normPush && normPush.includes(normAllowed)) {
        return true;
      }
    }
    return false;
  }

  public async autoStartSavedSessions(): Promise<void> {
    const instances = db
      .prepare(`SELECT id, name, status, auth_state_path FROM whatsapp_instances`)
      .all() as Array<{
      id: string;
      name: string;
      status: string;
      auth_state_path: string;
    }>;

    for (const inst of instances) {
      if (this.sockets.has(inst.id)) continue;
      const authDir = path.resolve(process.cwd(), inst.auth_state_path);
      const credsFile = path.join(authDir, 'creds.json');
      if (fs.existsSync(credsFile) || inst.status === 'CONNECTED' || inst.status === 'QR_READY') {
        console.log(`🔄 [Baileys AutoStart] Reconectando sessão salva: ${inst.name} (${inst.id})...`);
        this.startSession(inst.id).catch((err) =>
          console.error(`[Baileys AutoStart] Falha ao iniciar ${inst.id}:`, err.message)
        );
      }
    }

    // Cron interno a cada 45 segundos para verificar e auto-recuperar conversas que ficaram pendentes sem resposta
    setInterval(() => {
      for (const [instanceId] of this.sockets.entries()) {
        this.resumeUnansweredAllowedChats(instanceId).catch(() => undefined);
      }
    }, 45_000);
  }

  public async resumeUnansweredAllowedChats(instanceId: string): Promise<void> {
    const tenantConfig = schemaEngine.getTenantConfig(instanceId);
    if (tenantConfig?.allowedTestJids) {
      for (const j of tenantConfig.allowedTestJids) {
        if (j && j.trim()) ALLOWED_TEST_JIDS.add(j.trim());
      }
    }
    const isProductionAll = tenantConfig?.securityMode === 'PRODUCTION_ALL';

    // 1. Busca todas as conversas registradas nos logs
    const distinctChats = db
      .prepare(
        `SELECT DISTINCT remote_jid FROM hub_message_logs WHERE instance_id = ? ORDER BY created_at DESC LIMIT 30`
      )
      .all(instanceId) as Array<{ remote_jid: string }>;

    for (const { remote_jid: remoteJid } of distinctChats) {
      const lastLog = db
        .prepare(
          `SELECT * FROM hub_message_logs WHERE instance_id = ? AND remote_jid = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(instanceId, remoteJid) as
        | {
            id: string;
            remote_jid: string;
            sender_phone: string;
            push_name: string | null;
            direction: string;
            message_type: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT';
            raw_content: string | null;
            ai_transcription: string | null;
          }
        | undefined;

      if (!lastLog) continue;

      const isOwnerResumePrompt =
        lastLog.direction === 'OUTBOUND' &&
        lastLog.push_name === 'Você (Dono da Conta)' &&
        /\b(segue\s+o\s+baile|responde\s+a[ií]|chama\s+novamente)\b/i.test(
          lastLog.raw_content || ''
        );

      const targetLog = isOwnerResumePrompt
        ? (db
            .prepare(
              `SELECT * FROM hub_message_logs WHERE instance_id = ? AND remote_jid = ? AND direction = 'INBOUND' ORDER BY created_at DESC LIMIT 1`
            )
            .get(instanceId, remoteJid) as typeof lastLog)
        : lastLog.direction === 'INBOUND'
          ? lastLog
          : undefined;

      if (!targetLog) continue;

      const isAllowed =
        isProductionAll ||
        this.isContactAllowedByFilter(
          remoteJid,
          targetLog.push_name || '',
          ALLOWED_TEST_JIDS
        );

      if (!isAllowed) continue;

      const effectiveText = targetLog.raw_content || targetLog.ai_transcription || '';
      if (effectiveText) {
        this.lastKnownJidByPhone.set(targetLog.sender_phone, targetLog.remote_jid);
        webhookDispatcher
          .dispatch({
            event:
              targetLog.message_type === 'AUDIO' ? 'audio.transcribed' : 'message.received',
            instanceId,
            timestamp: new Date().toISOString(),
            data: {
              messageId: targetLog.id,
              fromPhone: targetLog.sender_phone,
              remoteJid: targetLog.remote_jid,
              pushName: targetLog.push_name || 'Cliente',
              messageType: targetLog.message_type,
              rawText: targetLog.raw_content || '',
              aiTranscription: targetLog.ai_transcription || effectiveText,
            },
          })
          .catch((err) => console.error('[AutoResume] Erro ao retomar resposta:', err));
      }
    }

    // 2. Auto-recuperação contextual inteligente de fichas IN_PROGRESS
    if (tenantConfig?.tenantId) {
      const activeRecords = db
        .prepare(
          `SELECT dr.id, dr.form_data, c.full_name, c.phone_number
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           WHERE dr.tenant_id = ? AND dr.status = 'IN_PROGRESS'
           ORDER BY dr.updated_at DESC LIMIT 10`
        )
        .all(tenantConfig.tenantId) as Array<{
        id: string;
        form_data: string;
        full_name: string;
        phone_number: string;
      }>;

      for (const rec of activeRecords) {
        // Busca o histórico das últimas 6 mensagens dessa conversa para entender todo o contexto
        const recentLogs = db
          .prepare(
            `SELECT raw_content, ai_transcription, direction, push_name, message_type, created_at, remote_jid
             FROM hub_message_logs
             WHERE instance_id = ? AND sender_phone = ?
             ORDER BY created_at DESC LIMIT 6`
          )
          .all(instanceId, rec.phone_number) as Array<{
            raw_content: string | null;
            ai_transcription: string | null;
            direction: string;
            push_name: string | null;
            message_type: string;
            created_at: string;
            remote_jid: string;
          }>;

        if (!recentLogs || recentLogs.length === 0) continue;

        const lastMsg = recentLogs[0];
        const targetJid = lastMsg.remote_jid || `${rec.phone_number}@s.whatsapp.net`;
        const firstName = rec.full_name.split(' ')[0] || rec.full_name;
        const fd = JSON.parse(rec.form_data || '{}');

        // Cenário A: O atendente humano enviou uma mensagem de ruído/não ouvi ou precisa de recuperação contextual
        const isAttendantManualNote =
          lastMsg.direction === 'OUTBOUND' &&
          lastMsg.push_name === 'Você (Dono da Conta)' &&
          /não consegui ouvir|pode enviar novamente/i.test(lastMsg.raw_content || '');

        if (isAttendantManualNote) {
          try {
            // Monta o histórico formatado em ordem cronológica
            const chronologicalLogs = [...recentLogs].reverse();
            const conversationHistoryText = chronologicalLogs
              .map((l) => {
                const speaker = l.direction === 'INBOUND' ? firstName : (l.push_name || 'Adenilde');
                const content = l.ai_transcription || l.raw_content || `[${l.message_type}]`;
                return `${speaker}: ${content}`;
              })
              .join('\n');

            console.log(`🧠 [AutoRecovery Contextual] Gerando retomada inteligente via IA para ${firstName}...`);
            const aiSynthesis = await geminiService.processInputAndExtractJson({
              systemInstruction: `Você é Adenilde da ADEN Massoterapia atendendo pelo WhatsApp com muita simpatia, educação e brevidade.
IMPORTANTE:
1. O cliente enviou mensagens ou áudios recentemente (inclusive escolhendo procedimento ou fazendo perguntas).
2. O atendente da loja acabou de enviar uma mensagem dizendo que não conseguiu ouvir ou pedindo para enviar novamente.
3. Analise com carinho as mensagens anteriores do cliente e a mensagem do atendente.
4. Confirme que agora você ouviu perfeitamente o que o cliente disse/pediu (cite o que o cliente pediu, ex: a sessão de massagem escolhida), e faça com naturalidade a próxima pergunta necessária para o agendamento (ex: se tem alergia a óleos/cremes ou se tem alguma condição de saúde).
5. Responda em tom curto e humano de WhatsApp (máximo 2 a 3 frases acolhedoras).`,
              recentHistory: conversationHistoryText,
              existingData: fd,
              text: `Por favor, elabore a mensagem de recuperação contextual para o cliente ${firstName}.`,
            });

            const replyText = aiSynthesis?.conversationalReply?.trim();
            if (replyText) {
              console.log(`🔄 [AutoRecovery Contextual] Enviando resposta para ${rec.full_name}: "${replyText}"`);
              await this.sendTextMessage({
                instanceId,
                toPhone: rec.phone_number,
                remoteJid: targetJid,
                text: replyText,
              });
            }
          } catch (err) {
            console.error('[AutoRecovery Contextual] Erro na geração com IA:', err);
          }
        }
      }
    }
  }

  public async startSession(
    instanceId: string
  ): Promise<{ status: string; qrCodeBase64?: string | null }> {
    const instanceRow = db
      .prepare(`SELECT * FROM whatsapp_instances WHERE id = ?`)
      .get(instanceId) as
      | {
          id: string;
          name: string;
          status: string;
          qr_code_base64: string | null;
          auth_state_path: string;
        }
      | undefined;

    if (!instanceRow) {
      throw new Error(`Instância WhatsApp '${instanceId}' não encontrada.`);
    }

    this.stoppedOrDeletedInstances.delete(instanceId);

    if (this.sockets.has(instanceId)) {
      return {
        status: instanceRow.status,
        qrCodeBase64: instanceRow.qr_code_base64,
      };
    }

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;
    const { DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState } =
      baileys;
    const pinoMod = await import('pino');
    const QRCode = (await import('qrcode')).default;
    const logger = pinoMod.default({ level: 'silent' });

    const authDir = path.resolve(process.cwd(), instanceRow.auth_state_path);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307] as [number, number, number],
    }));

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: ['WhatsApp AI Core Hub', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      getMessage: async (key: any) => {
        if (!key?.id) return undefined;
        const row = db
          .prepare(
            `SELECT raw_content, ai_transcription FROM hub_message_logs WHERE id = ? OR id = ? LIMIT 1`
          )
          .get(key.id, `msg_${key.id}`) as
          | { raw_content: string | null; ai_transcription: string | null }
          | undefined;
        if (row?.raw_content || row?.ai_transcription) {
          return {
            conversation: row.raw_content || row.ai_transcription || '',
          };
        }
        return undefined;
      },
    });

    this.sockets.set(instanceId, sock);

    sock.ev.on('creds.update', saveCreds);

    // Tratamento de erro na conexão do Baileys para nunca derrubar o processo do servidor
    (sock.ws as any)?.on?.('error', (err: any) => {
      console.error(`⚠️ [Baileys WS Error] instance=${instanceId}:`, err?.message || err);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrBase64 = await QRCode.toDataURL(qr);
        db.prepare(
          `UPDATE whatsapp_instances SET status = 'QR_READY', qr_code_base64 = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(qrBase64, instanceId);

        await webhookDispatcher.dispatch({
          event: 'session.status',
          instanceId,
          timestamp: new Date().toISOString(),
          data: { sessionStatus: 'QR_READY' },
        });
      }

      if (connection === 'open') {
        const connectedPhone = sock.user?.id ? sock.user.id.split(':')[0] : null;
        db.prepare(
          `UPDATE whatsapp_instances SET status = 'CONNECTED', phone_number = ?, qr_code_base64 = NULL, updated_at = datetime('now') WHERE id = ?`
        ).run(connectedPhone, instanceId);

        await webhookDispatcher.dispatch({
          event: 'session.status',
          instanceId,
          timestamp: new Date().toISOString(),
          data: { sessionStatus: 'CONNECTED', fromPhone: connectedPhone || undefined },
        });

        await this.resumeUnansweredAllowedChats(instanceId);
      }

      if (connection === 'close') {
        this.sockets.delete(instanceId);
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        console.log(`⚠️ [Baileys Connection Close] instance=${instanceId} statusCode=${statusCode} error=`, lastDisconnect?.error);
        const stillExists = db
          .prepare(`SELECT id FROM whatsapp_instances WHERE id = ?`)
          .get(instanceId);
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;
        // Se for erro 440 (conflito temporário de stream), reconecta com backoff em 5s
        const isStreamConflict = statusCode === 440;
        const shouldReconnect =
          Boolean(stillExists) &&
          !this.stoppedOrDeletedInstances.has(instanceId) &&
          !isLoggedOut &&
          !isReplaced;

        if (stillExists) {
          db.prepare(
            `UPDATE whatsapp_instances SET status = 'DISCONNECTED', qr_code_base64 = NULL, updated_at = datetime('now') WHERE id = ?`
          ).run(instanceId);
        }

        if (isLoggedOut && stillExists) {
          // Limpa credenciais expiradas para permitir gerar novo QR Code imediatamente
          try {
            if (fs.existsSync(authDir)) {
              fs.rmSync(authDir, { recursive: true, force: true });
            }
          } catch {
            // Ignora erro de limpeza
          }
        }

        if (shouldReconnect) {
          setTimeout(() => {
            if (!this.stoppedOrDeletedInstances.has(instanceId)) {
              this.startSession(instanceId).catch((err) =>
                console.error(`[Baileys] Erro ao reconectar ${instanceId}:`, err.message)
              );
            }
          }, 4000);
        }
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processIncomingMessagesBatch = async (messages: any[], type: string) => {
      if (type !== 'notify' && type !== 'append' && type !== 'history') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const msgId = msg.key?.id || '';
        if (msgId && (this.botSentMessageIds.has(msgId) || this.processedIncomingMsgIds.has(msgId))) {
          continue;
        }

        // Em eventos de sincronização ('append' ou 'history'), ignora mensagens antigas (> 6 horas)
        if (type === 'append' || type === 'history') {
          const rawTs = msg.messageTimestamp;
          const msgTimeSec =
            typeof rawTs === 'number'
              ? rawTs
              : Number(rawTs?.low || rawTs || 0);
          if (msgTimeSec > 0) {
            const ageSec = Math.floor(Date.now() / 1000) - msgTimeSec;
            if (ageSec > 6 * 3600) {
              continue;
            }
          }
          if (msgId) {
            const alreadyLogged = db
              .prepare(`SELECT id FROM hub_message_logs WHERE id = ?`)
              .get(`msg_${msgId}`);
            if (alreadyLogged) continue;
          }
        }

        const innerMsg = this.unwrapBaileysMessage(msg.message);
        if (!innerMsg) continue;

        const deviceDestJid: string = msg.message?.deviceSentMessage?.destinationJid || '';
        const remoteJid: string = deviceDestJid || msg.key?.remoteJid || '';
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        const rawText = (
          innerMsg.conversation ||
          innerMsg.extendedTextMessage?.text ||
          innerMsg.imageMessage?.caption ||
          innerMsg.videoMessage?.caption ||
          innerMsg.buttonsResponseMessage?.selectedDisplayText ||
          innerMsg.listResponseMessage?.title ||
          innerMsg.templateButtonReplyMessage?.selectedDisplayText ||
          ''
        ).trim();

        const hasAudio = Boolean(innerMsg.audioMessage);
        const hasImage = Boolean(innerMsg.imageMessage);

        if (!rawText && !hasAudio && !hasImage) {
          continue;
        }

        if (rawText && this.botReplySignatures.some((sig) => rawText.startsWith(sig))) {
          continue;
        }

        if (msgId) {
          this.processedIncomingMsgIds.add(msgId);
          setTimeout(() => this.processedIncomingMsgIds.delete(msgId), 300_000);
        }

        // ====================================================================
        // TRAVA DE SEGURANÇA POR EMPRESA (securityMode + allowedTestJids):
        // Lê a configuração de segurança da empresa vinculada a esta instância!
        // ====================================================================
        const tenantConfig = schemaEngine.getTenantConfig(instanceId);
        const isFromOwner = Boolean(msg.key?.fromMe);
        const incomingPushName = (msg.pushName || '').trim();

        console.log(
          `📩 [Baileys ${type}] inst=${instanceId} jid=${remoteJid} fromMe=${isFromOwner} pushName="${incomingPushName}" text="${rawText.slice(0, 60)}"`
        );

        // Sincroniza lista de JIDs permitidos da empresa com o Set em memória
        if (tenantConfig?.allowedTestJids) {
          for (const j of tenantConfig.allowedTestJids) {
            if (j && j.trim()) ALLOWED_TEST_JIDS.add(j.trim());
          }
        }

        // Auto-autoriza o chat do Ricardo Messias Batista assim que ele mandar mensagem
        // ou quando você mandar uma mensagem para ele contendo "ricardo", "#liberar", "#teste" ou "agendar"
        if (
          (!isFromOwner && /ricardo|ricarod|messias\s+batista/i.test(incomingPushName)) ||
          (isFromOwner && /\b(ricardo|ricarod|#liberar|#teste|agendar|segue\s+o\s+baile|responde\s+a[ií]|chama\s+novamente)\b/i.test(rawText))
        ) {
          if (!ALLOWED_TEST_JIDS.has(remoteJid)) {
            ALLOWED_TEST_JIDS.add(remoteJid);
            console.log(
              `🔓 [Baileys Filtro Seguro] Conversa autorizada automaticamente: ${remoteJid} (${incomingPushName})`
            );
          }
        }

        // Identifica se a profissional está enviando mensagem no chat "Você (Mensagem para si mesma)"
        const ownPhonePrefix = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
        const ownLidPrefix = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
        const remotePrefix = remoteJid.split(':')[0].split('@')[0];
        const isSelfChat =
          Boolean(ownPhonePrefix && remotePrefix === ownPhonePrefix) ||
          Boolean(ownLidPrefix && remotePrefix === ownLidPrefix);

        const isExplicitOwnerCommand = /^#(reset|ficha|prof|agenda|atendi|confirmar|servicos|servico)\b/i.test(rawText);
        const isProductionAll = tenantConfig?.securityMode === 'PRODUCTION_ALL';
        const isAllowedChat =
          isSelfChat ||
          isExplicitOwnerCommand ||
          isProductionAll ||
          this.isContactAllowedByFilter(remoteJid, incomingPushName, ALLOWED_TEST_JIDS);

        const jidUserPart = remoteJid.split('@')[0].split(':')[0];
        const senderPhone = jidUserPart.replace(/\D/g, '');
        this.lastKnownJidByPhone.set(senderPhone, remoteJid);

        if (!isAllowedChat) {
          // Registra a mensagem recebida no log mesmo se estiver bloqueada pelo Modo Teste,
          // para que se a empresa autorizar o contato ou mudar para Produção depois, possa retomar!
          if (!isFromOwner && rawText) {
            const logId = msgId ? `msg_${msgId}` : `msg_${crypto.randomUUID()}`;
            db.prepare(
              `INSERT OR IGNORE INTO hub_message_logs (
                id, instance_id, remote_jid, sender_phone, push_name, direction, message_type, raw_content
              ) VALUES (?, ?, ?, ?, ?, 'INBOUND', 'TEXT', ?)`
            ).run(
              logId,
              instanceId,
              remoteJid,
              senderPhone,
              incomingPushName || 'Cliente',
              rawText
            );
          }
          continue;
        }

        // Se a mensagem foi enviada por VOCÊ (fromMe === true):
        // - Se for no chat de um cliente normal e NÃO tiver comando (#reset, #ficha, #prof, #agenda, #atendi), apenas loga sem responder
        // - Se for no seu próprio chat "Você" (isSelfChat) ou tiver comando explícito, processa como Assistente da Profissional!
        if (isFromOwner && !isSelfChat && !isExplicitOwnerCommand) {
          db.prepare(
            `INSERT OR IGNORE INTO hub_message_logs (
              id, instance_id, remote_jid, sender_phone, push_name, direction, message_type, raw_content
            ) VALUES (?, ?, ?, ?, ?, 'OUTBOUND', 'TEXT', ?)`
          ).run(
            msgId ? `msg_${msgId}` : `msg_${crypto.randomUUID()}`,
            instanceId,
            remoteJid,
            senderPhone,
            'Você (Dono da Conta)',
            rawText
          );

          // Se você enviar "segue o baile", "responde ai" ou "chama novamente" no chat do cliente, retoma a última mensagem dele na hora!
          if (/\b(segue\s+o\s+baile|responde\s+a[ií]|chama\s+novamente)\b/i.test(rawText)) {
            const quotedMsg = this.unwrapBaileysMessage(
              innerMsg.extendedTextMessage?.contextInfo?.quotedMessage
            );
            const quotedText = (
              quotedMsg?.conversation ||
              quotedMsg?.extendedTextMessage?.text ||
              ''
            ).trim();

            const lastInbound = db
              .prepare(
                `SELECT * FROM hub_message_logs WHERE instance_id = ? AND remote_jid = ? AND direction = 'INBOUND' ORDER BY created_at DESC LIMIT 1`
              )
              .get(instanceId, remoteJid) as
              | {
                  id: string;
                  push_name: string | null;
                  message_type: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT';
                  raw_content: string | null;
                  ai_transcription: string | null;
                }
              | undefined;
            if (lastInbound) {
              webhookDispatcher
                .dispatch({
                  event:
                    lastInbound.message_type === 'AUDIO' ? 'audio.transcribed' : 'message.received',
                  instanceId,
                  timestamp: new Date().toISOString(),
                  data: {
                    messageId: lastInbound.id,
                    fromPhone: senderPhone,
                    remoteJid,
                    pushName: lastInbound.push_name || 'Cliente',
                    messageType: lastInbound.message_type,
                    rawText: lastInbound.raw_content || '',
                    aiTranscription:
                      lastInbound.ai_transcription || lastInbound.raw_content || '',
                  },
                })
                .catch((err) => console.error('[OwnerResume] Erro ao retomar:', err));
            } else {
              // Se a mensagem do cliente foi enviada antes do bot conectar, usa o texto citado ou inicia o atendimento!
              const fallbackText =
                quotedText || 'Olá! Gostaria de saber sobre massagem e agendamento.';
              this.recordAndDispatchInbound({
                instanceId,
                remoteJid,
                senderPhone,
                pushName: 'Cliente',
                messageType: 'TEXT',
                rawText: fallbackText,
              }).catch((err) => console.error('[OwnerResumeFallback] Erro ao iniciar:', err));
            }
          }
          continue;
        }

        const pushName = isFromOwner
          ? isSelfChat
            ? 'Profissional (Chat Pessoal)'
            : 'Profissional (Comando)'
          : (msg.pushName || 'Cliente').trim();

        let messageType: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT' = 'TEXT';
        let aiTranscription = '';
        let aiExtractedData: Record<string, unknown> = {};

        try {
          if (hasAudio) {
            messageType = 'AUDIO';
            const buffer = (await downloadMediaMessage(
              { ...msg, message: innerMsg },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            )) as Buffer;

            const aiResult = await geminiService.processInputAndExtractJson({
              systemInstruction:
                'Transcreva fielmente palavra por palavra em português tudo o que a pessoa falou neste áudio do WhatsApp.',
              mediaBase64: buffer.toString('base64'),
              mimeType: innerMsg.audioMessage.mimetype || 'audio/ogg',
              skillMarkdown: tenantConfig?.skillMarkdown,
              apiKeyOverride: tenantConfig?.aiApiKey,
              modelOverride: tenantConfig?.aiModel,
            });
            aiTranscription = aiResult.transcription;
            aiExtractedData = aiResult.extractedData;
            console.log(`🎙️ [Baileys Transcrição de Áudio - ${pushName}]: "${aiTranscription}"`);
          } else if (hasImage) {
            messageType = 'IMAGE';
            const buffer = (await downloadMediaMessage(
              { ...msg, message: innerMsg },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            )) as Buffer;

            const aiResult = await geminiService.processInputAndExtractJson({
              text: rawText || 'Extraia todos os dados preenchidos nesta ficha ou imagem.',
              mediaBase64: buffer.toString('base64'),
              mimeType: innerMsg.imageMessage.mimetype || 'image/jpeg',
              skillMarkdown: tenantConfig?.skillMarkdown,
              apiKeyOverride: tenantConfig?.aiApiKey,
              modelOverride: tenantConfig?.aiModel,
            });
            aiTranscription = aiResult.transcription;
            aiExtractedData = aiResult.extractedData;
          }
        } catch (err) {
          console.error(`[Baileys] Erro ao processar mídia com Gemini:`, err);
        }

        const effectiveRawText =
          isSelfChat && rawText && !rawText.startsWith('#') ? `#prof ${rawText}` : rawText;
        const effectiveAiTranscription =
          isSelfChat && aiTranscription && !aiTranscription.startsWith('#')
            ? `#prof ${aiTranscription}`
            : aiTranscription;

        // Buffer de 1.2 segundos para mensagens de TEXTO de clientes:
        // Se o cliente mandar "Olá" e 0.5s depois "Boa noite !", agrupa em uma única chamada
        if (messageType === 'TEXT' && !isSelfChat && !isExplicitOwnerCommand) {
          const bufferKey = `${instanceId}:${remoteJid}`;
          const existingBuffer = this.pendingTextBuffers.get(bufferKey);
          if (existingBuffer) {
            clearTimeout(existingBuffer.timer);
            existingBuffer.texts.push(effectiveRawText);
            existingBuffer.timer = setTimeout(() => {
              const mergedText = existingBuffer.texts.join('\n');
              this.pendingTextBuffers.delete(bufferKey);
              this.recordAndDispatchInbound({
                ...existingBuffer.baseParams,
                messageType: 'TEXT',
                rawText: mergedText,
              }).catch((err) => console.error('[Baileys Buffer] Erro ao despachar:', err));
            }, 1200);
          } else {
            const texts = [effectiveRawText];
            const baseParams = { instanceId, remoteJid, senderPhone, pushName };
            const timer = setTimeout(() => {
              const buf = this.pendingTextBuffers.get(bufferKey);
              const mergedText = buf ? buf.texts.join('\n') : effectiveRawText;
              this.pendingTextBuffers.delete(bufferKey);
              this.recordAndDispatchInbound({
                ...baseParams,
                messageType: 'TEXT',
                rawText: mergedText,
              }).catch((err) => console.error('[Baileys Buffer] Erro ao despachar:', err));
            }, 1200);
            this.pendingTextBuffers.set(bufferKey, { timer, texts, baseParams });
          }
          continue;
        }

        await this.recordAndDispatchInbound({
          instanceId,
          remoteJid,
          senderPhone,
          pushName,
          messageType,
          rawText: effectiveRawText,
          aiTranscription: effectiveAiTranscription,
          aiExtractedData,
        });
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      await processIncomingMessagesBatch(messages, type);
    });

    // Captura também mensagens recentes não respondidas sincronizadas na conexão inicial
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sock.ev.on('messaging-history.set', async ({ messages }: { messages: any[] }) => {
      if (Array.isArray(messages) && messages.length > 0) {
        // Filtra apenas a última mensagem de cada conversa enviada por cliente nas últimas 4 horas
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const latestByJid = new Map<string, any>();
        for (const m of messages) {
          const jid = m?.key?.remoteJid;
          if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
          const prev = latestByJid.get(jid);
          const prevTs = Number(prev?.messageTimestamp?.low || prev?.messageTimestamp || 0);
          const curTs = Number(m?.messageTimestamp?.low || m?.messageTimestamp || 0);
          if (!prev || curTs >= prevTs) {
            latestByJid.set(jid, m);
          }
        }
        const recentUnanswered = Array.from(latestByJid.values()).filter(
          (m) => !m.key?.fromMe
        );
        if (recentUnanswered.length > 0) {
          await processIncomingMessagesBatch(recentUnanswered, 'history');
        }
      }
    });

    return {
      status: 'STARTING',
      qrCodeBase64: instanceRow.qr_code_base64,
    };
  }

  public async stopSession(instanceId: string, logout = false): Promise<void> {
    this.stoppedOrDeletedInstances.add(instanceId);
    const sock = this.sockets.get(instanceId);
    if (sock) {
      if (logout) {
        await sock.logout().catch(() => undefined);
      } else {
        sock.end(undefined);
      }
      this.sockets.delete(instanceId);
    }

    if (logout) {
      const row = db
        .prepare(`SELECT auth_state_path FROM whatsapp_instances WHERE id = ?`)
        .get(instanceId) as { auth_state_path?: string } | undefined;
      if (row?.auth_state_path) {
        const authDir = path.resolve(process.cwd(), row.auth_state_path);
        try {
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
        } catch (err) {
          console.error(`[Baileys] Aviso ao limpar pasta de sessão (${instanceId}):`, err);
        }
      }
    }

    db.prepare(
      `UPDATE whatsapp_instances SET status = 'DISCONNECTED', phone_number = CASE WHEN ? = 1 THEN NULL ELSE phone_number END, qr_code_base64 = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(logout ? 1 : 0, instanceId);
  }

  public async deleteSession(instanceId: string): Promise<void> {
    this.stoppedOrDeletedInstances.add(instanceId);

    const row = db
      .prepare(`SELECT auth_state_path FROM whatsapp_instances WHERE id = ?`)
      .get(instanceId) as { auth_state_path?: string } | undefined;

    const sock = this.sockets.get(instanceId);
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // Ignora erro de encerramento do socket
      }
      this.sockets.delete(instanceId);
    }

    if (row?.auth_state_path) {
      const authDir = path.resolve(process.cwd(), row.auth_state_path);
      try {
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      } catch (err) {
        console.error(`[Baileys] Aviso ao remover diretório de sessão (${instanceId}):`, err);
      }
    }

    // Desvincula empresas que usavam esta sessão e exclui os logs/webhooks/instância
    db.prepare(`UPDATE tenants SET whatsapp_instance_id = NULL WHERE whatsapp_instance_id = ?`).run(
      instanceId
    );
    db.prepare(`DELETE FROM hub_message_logs WHERE instance_id = ?`).run(instanceId);
    db.prepare(`DELETE FROM webhook_subscriptions WHERE instance_id = ?`).run(instanceId);
    db.prepare(`DELETE FROM whatsapp_instances WHERE id = ?`).run(instanceId);
  }

  public async sendTextMessage(
    options: SendMessageOptions
  ): Promise<{ messageId: string; delivered: boolean }> {
    const cleanPhone = options.toPhone.replace(/\D/g, '');

    // Busca preferencialmente o remote_jid real da última mensagem RECEBIDA (INBOUND) do cliente
    let resolvedJid = options.remoteJid;
    if (!resolvedJid || resolvedJid.endsWith('@s.whatsapp.net')) {
      const dbInboundLog = db
        .prepare(
          `SELECT remote_jid FROM hub_message_logs
           WHERE instance_id = ? AND sender_phone = ? AND direction = 'INBOUND'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(options.instanceId, cleanPhone) as { remote_jid?: string } | undefined;

      if (dbInboundLog?.remote_jid) {
        resolvedJid = dbInboundLog.remote_jid;
      }
    }

    const remoteJid =
      resolvedJid ||
      this.lastKnownJidByPhone.get(cleanPhone) ||
      (options.toPhone.includes('@') ? options.toPhone : `${cleanPhone}@s.whatsapp.net`);

    const sock = this.sockets.get(options.instanceId);
    const logId = `msg_${crypto.randomUUID()}`;

    // TRAVA ANTI-DUPLICAÇÃO RÍGIDA:
    // Se enviou mensagem para o mesmo JID há menos de 3.5 segundos, ou se for o mesmo texto há menos de 30 segundos, bloqueia!
    const now = Date.now();
    const lastSentTime = this.lastSentTimeByJid.get(remoteJid) || 0;
    const lastSentContent = this.lastSentContentByJid.get(remoteJid) || '';
    const isTooFast = now - lastSentTime < 3500;
    const isSameTextRecent = now - lastSentTime < 30000 && lastSentContent.trim() === options.text.trim();

    if (isTooFast || isSameTextRecent) {
      console.warn(`🛑 [Baileys Anti-Duplicação] Bloqueado envio duplicado/em rajada para ${remoteJid} (intervalo=${now - lastSentTime}ms). Texto: "${options.text.slice(0, 40)}..."`);
      return { messageId: logId, delivered: false };
    }

    this.lastSentTimeByJid.set(remoteJid, now);
    this.lastSentContentByJid.set(remoteJid, options.text);

    let delivered = false;
    if (sock) {
      try {
        console.log(`📤 [Baileys Outbound] Enviando para ${remoteJid}... texto: "${options.text}"`);
        // 1. Pausa humana curta de leitura antes de começar a digitar (1.0s a 1.8s)
        const readDelayMs = 1000 + Math.floor(Math.random() * 800);
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));

        // 2. Ativa o status "digitando..." real no topo do WhatsApp da pessoa
        await sock.sendPresenceUpdate('composing', remoteJid).catch(() => undefined);

        // 3. Tempo de digitação ágil e natural (~25ms por caractere, de 1.5s a 4.5s no máximo)
        const charTypingMs = Math.min(4500, Math.max(1500, options.text.length * 25));
        const jitterMs = Math.floor(Math.random() * 600);
        const totalTypingMs = charTypingMs + jitterMs;

        // Mantém o status "digitando..." ativo durante a digitação
        let elapsed = 0;
        while (elapsed < totalTypingMs) {
          const chunk = Math.min(2500, totalTypingMs - elapsed);
          await new Promise((resolve) => setTimeout(resolve, chunk));
          elapsed += chunk;
          if (elapsed < totalTypingMs) {
            await sock.sendPresenceUpdate('composing', remoteJid).catch(() => undefined);
          }
        }

        // 4. Finaliza o "digitando..." e envia a mensagem imediatamente
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => undefined);

        const sent = await sock.sendMessage(remoteJid, { text: options.text });
        console.log(`✅ [Baileys Outbound] Mensagem entregue ao WhatsApp! ID=${sent?.key?.id}`);
        if (sent?.key?.id) {
          this.botSentMessageIds.add(sent.key.id);
          setTimeout(() => this.botSentMessageIds.delete(sent.key.id), 120_000);
        }
        delivered = true;
      } catch (sendErr) {
        console.error(`❌ [Baileys Outbound] Falha ao enviar para ${remoteJid}:`, sendErr);
      }
    } else {
      console.warn(`⚠️ [Baileys Outbound] Socket não encontrado na memória para instância ${options.instanceId}! A mensagem não pôde ser transmitida.`);
    }

    db.prepare(
      `INSERT INTO hub_message_logs (
        id, instance_id, remote_jid, sender_phone, direction, message_type, raw_content
      ) VALUES (?, ?, ?, ?, 'OUTBOUND', 'TEXT', ?)`
    ).run(logId, options.instanceId, remoteJid, cleanPhone, options.text);

    return { messageId: logId, delivered };
  }

  public async recordAndDispatchInbound(params: {
    instanceId: string;
    remoteJid: string;
    senderPhone: string;
    pushName: string;
    messageType: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT';
    rawText: string;
    aiTranscription?: string;
    aiExtractedData?: Record<string, unknown>;
  }): Promise<string> {
    const logId = `msg_${crypto.randomUUID()}`;
    this.lastKnownJidByPhone.set(params.senderPhone, params.remoteJid);

    db.prepare(
      `INSERT INTO hub_message_logs (
        id, instance_id, remote_jid, sender_phone, push_name, direction, message_type, raw_content, ai_transcription, ai_extracted_json
      ) VALUES (?, ?, ?, ?, ?, 'INBOUND', ?, ?, ?, ?)`
    ).run(
      logId,
      params.instanceId,
      params.remoteJid,
      params.senderPhone,
      params.pushName,
      params.messageType,
      params.rawText,
      params.aiTranscription || null,
      params.aiExtractedData ? JSON.stringify(params.aiExtractedData) : null
    );

    await webhookDispatcher.dispatch({
      event: params.messageType === 'AUDIO' ? 'audio.transcribed' : 'message.received',
      instanceId: params.instanceId,
      timestamp: new Date().toISOString(),
      data: {
        messageId: logId,
        fromPhone: params.senderPhone,
        remoteJid: params.remoteJid,
        pushName: params.pushName,
        messageType: params.messageType,
        rawText: params.rawText,
        aiTranscription: params.aiTranscription,
        aiExtractedData: params.aiExtractedData,
      },
    });

    return logId;
  }
}

export const whatsappManager = new BaileysMultiSessionManager();
