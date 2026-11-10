import crypto from 'node:crypto';
import { db } from '../database/db.ts';
import { geminiService } from '../hub/ai/gemini.service.ts';
import { type HubEventPayload, webhookDispatcher } from '../hub/webhooks/webhook.dispatcher.ts';
import { whatsappManager } from '../hub/whatsapp/baileys.manager.ts';
import {
  type EffectiveTenantConfig,
  isProfessionalActivelyResponding,
  isWithinWhatsAppSupportHours,
  schemaEngine,
} from './schema.engine.ts';

export interface OrchestratorActionResult {
  mode: 'PROFESSIONAL_QUERY' | 'PROFESSIONAL_DICTATION' | 'CLIENT_INTERVIEW' | 'IGNORED_CASUAL';
  replyMessage: string;
  customerId?: string;
  recordId?: string;
  evolutionId?: string;
  recordStatus?: string;
  activeAlerts?: string[];
  formData?: Record<string, unknown>;
}

export class ConversationOrchestrator {
  private initialized = false;
  private queueInterval: NodeJS.Timeout | null = null;
  private activeProcessingByPhone = new Map<string, Promise<OrchestratorActionResult | null>>();

  public initListeners(): void {
    if (this.initialized) return;
    this.initialized = true;

    const handler = async (payload: HubEventPayload) => {
      try {
        await this.handleInboundEvent(payload);
      } catch (err) {
        console.error('[ConversationOrchestrator] Erro ao processar mensagem:', err);
      }
    };

    webhookDispatcher.on('message.received', handler);
    webhookDispatcher.on('audio.transcribed', handler);

    // Processa periodicamente a fila de fora de expediente a cada 60 segundos
    if (!this.queueInterval) {
      this.queueInterval = setInterval(() => {
        this.processOutOfHoursQueue().catch((err) =>
          console.error('[ConversationOrchestrator] Erro no worker da fila out_of_hours_queue:', err)
        );
      }, 60_000);
    }
  }

  public async handleInboundEvent(
    payload: HubEventPayload
  ): Promise<OrchestratorActionResult | null> {
    const fromPhone = (payload.data.fromPhone || '').replace(/\D/g, '');
    if (!fromPhone) return null;

    // Mutex / Serializador de chamadas por cliente para eliminar 100% o risco de mensagens duplicadas
    const currentPromise = this.activeProcessingByPhone.get(fromPhone) || Promise.resolve(null);
    const newPromise = currentPromise
      .then(async () => {
        return await this.executeInboundEvent(payload);
      })
      .catch((err) => {
        console.error(`[ConversationOrchestrator] Erro no pipeline de ${fromPhone}:`, err);
        return null;
      })
      .finally(() => {
        if (this.activeProcessingByPhone.get(fromPhone) === newPromise) {
          this.activeProcessingByPhone.delete(fromPhone);
        }
      });

    this.activeProcessingByPhone.set(fromPhone, newPromise);
    return newPromise;
  }

  private async executeInboundEvent(
    payload: HubEventPayload
  ): Promise<OrchestratorActionResult | null> {
    const config = schemaEngine.getTenantConfig(payload.instanceId);
    if (!config) return null;

    const fromPhone = (payload.data.fromPhone || '').replace(/\D/g, '');
    const userText = (
      payload.data.aiTranscription ||
      payload.data.rawText ||
      ''
    ).trim();

    if (!fromPhone || !userText) return null;

    // 1. Comandos explícitos ou Mensagens da Profissional (#prof, #ficha, #agenda, #atendi, #confirmar, #relatorio, #negocio, conversa consigo mesma "Você" ou ownerPhone)
    if (
      fromPhone === config.ownerPhone ||
      /^#(prof|ficha|agenda|atendi|confirmar|relatorio|negocio|desempenho)\b/i.test(userText.trim())
    ) {
      const cleanProfText = userText.replace(/^#prof\s+/i, '').trim();
      const result = await this.handleProfessionalMessage(config, fromPhone, cleanProfText);
      if (result.mode === 'IGNORED_CASUAL' || !result.replyMessage) {
        return result;
      }
      await whatsappManager.sendTextMessage({
        instanceId: config.whatsappInstanceId,
        toPhone: fromPhone,
        remoteJid: payload.data.remoteJid,
        text: result.replyMessage,
      });
      return result;
    }

    // 2. Comando explícito #reset para limpar ficha de teste
    if (/^#reset\b/i.test(userText)) {
      const cust = db
        .prepare(`SELECT id FROM customers WHERE tenant_id = ? AND phone_number = ?`)
        .get(config.tenantId, fromPhone) as { id: string } | undefined;
      if (cust) {
        db.prepare(`DELETE FROM dynamic_records WHERE customer_id = ?`).run(cust.id);
      }
      const firstQ = config.formSchema[0]?.questionPrompt || 'Como podemos ajudar?';
      const resetReply = `🔄 *Ficha reiniciada para novo teste!*\n\n👉 ${firstQ}`;
      await whatsappManager.sendTextMessage({
        instanceId: config.whatsappInstanceId,
        toPhone: fromPhone,
        remoteJid: payload.data.remoteJid,
        text: resetReply,
      });
      return {
        mode: 'CLIENT_INTERVIEW',
        replyMessage: resetReply,
      };
    }

    // ========================================================================
    // 3. VALIDAÇÃO DE INTERVENÇÃO HUMANA ("meu cliente já respondendo o cliente dele")
    // Se a profissional (Adenilde) enviou mensagem manual recente para este cliente, o robô NÃO deve intervir!
    // ========================================================================
    const isActivelyResponding = isProfessionalActivelyResponding({
      tenantId: config.tenantId,
      instanceId: config.whatsappInstanceId,
      senderPhone: fromPhone,
      remoteJid: payload.data.remoteJid,
      sinceMinutes: 20,
    });

    if (isActivelyResponding) {
      console.log(
        `🔇 [Intervenção Humana Ativa] A profissional está conversando com o cliente (${fromPhone}). Robô em silêncio absoluto.`
      );
      return {
        mode: 'IGNORED_CASUAL',
        replyMessage: '',
      };
    }

    // ========================================================================
    // 4. VALIDAÇÃO DO HORÁRIO DE ATENDIMENTO DO WHATSAPP & FILA NOTURNA
    // Se estiver fora do expediente do WhatsApp, coloca na fila out_of_hours_queue!
    // ========================================================================
    const hoursCheck = isWithinWhatsAppSupportHours(config.whatsappHoursConfig);
    if (!hoursCheck.isWithinHours) {
      console.log(
        `🌙 [Fora de Expediente WhatsApp] Mensagem de ${fromPhone} enfileirada na out_of_hours_queue (${hoursCheck.reason}).`
      );

      const queueId = `q_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(`
        INSERT INTO out_of_hours_queue (
          id, tenant_id, instance_id, remote_jid, sender_phone, push_name, message_type, raw_content, ai_transcription, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')
      `).run(
        queueId,
        config.tenantId,
        config.whatsappInstanceId,
        payload.data.remoteJid,
        fromPhone,
        payload.data.pushName || 'Cliente',
        payload.data.messageType || 'TEXT',
        payload.data.rawText || '',
        payload.data.aiTranscription || ''
      );

      // Envia aviso amigável de fora de expediente se configurado (no máximo 1 vez a cada 12h por cliente)
      if (config.whatsappHoursConfig?.autoReplyOutOfHours && config.whatsappHoursConfig?.outOfHoursMessage) {
        const alreadySent = db
          .prepare(
            `SELECT id FROM hub_message_logs
             WHERE remote_jid = ? AND direction = 'OUTBOUND'
               AND raw_content = ? AND created_at >= datetime('now', '-12 hours')
             LIMIT 1`
          )
          .get(payload.data.remoteJid, config.whatsappHoursConfig.outOfHoursMessage);

        if (!alreadySent) {
          await whatsappManager.sendTextMessage({
            instanceId: config.whatsappInstanceId,
            toPhone: fromPhone,
            remoteJid: payload.data.remoteJid,
            text: config.whatsappHoursConfig.outOfHoursMessage,
          });
        }
      }

      return {
        mode: 'CLIENT_INTERVIEW',
        replyMessage: '',
      };
    }

    // 5. Fluxo Contextual do Cliente: analisa o contexto antes de responder!
    const cleanClientText = userText.replace(/^#teste\s*/i, '').trim() || 'Oi';
    const result = await this.handleClientInterview(
      config,
      fromPhone,
      payload.data.pushName || 'Cliente',
      cleanClientText,
      payload.data.messageType
    );

    if (result.mode === 'IGNORED_CASUAL' || !result.replyMessage) {
      return result;
    }

    // Deduplicação: se a última mensagem enviada pelo bot nos últimos 8 segundos tiver o mesmo texto, não reenvia!
    const lastOutbound = db
      .prepare(
        `SELECT raw_content FROM hub_message_logs
         WHERE (remote_jid = ? OR sender_phone = ?) AND direction = 'OUTBOUND' AND created_at >= datetime('now', '-8 seconds')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(payload.data.remoteJid, fromPhone) as { raw_content: string } | undefined;

    if (lastOutbound && lastOutbound.raw_content === result.replyMessage) {
      console.log(`⚠️ [Deduplicação] Mensagem idêntica recém-enviada para ${fromPhone}. Ignorando duplicação.`);
      return result;
    }

    await whatsappManager.sendTextMessage({
      instanceId: config.whatsappInstanceId,
      toPhone: fromPhone,
      remoteJid: payload.data.remoteJid,
      text: result.replyMessage,
    });

    return result;
  }

  /**
   * Processa a fila de mensagens recebidas fora de expediente (out_of_hours_queue).
   * Antes de responder qualquer mensagem da fila, valida se o profissional já respondeu manualmente o cliente dele!
   */
  public async processOutOfHoursQueue(tenantId?: string): Promise<{ processed: number; skipped: number }> {
    const tenants = tenantId
      ? [schemaEngine.getTenantConfig(tenantId)].filter((t): t is EffectiveTenantConfig => Boolean(t))
      : (db.prepare(`SELECT id FROM tenants`).all() as Array<{ id: string }>)
          .map((t) => schemaEngine.getTenantConfig(t.id))
          .filter((t): t is EffectiveTenantConfig => Boolean(t));

    let processedCount = 0;
    let skippedCount = 0;

    for (const config of tenants) {
      const hoursCheck = isWithinWhatsAppSupportHours(config.whatsappHoursConfig);
      // Se ainda estiver fora do expediente do WhatsApp, não despacha a fila ainda
      if (!hoursCheck.isWithinHours) continue;

      const queuedItems = db
        .prepare(
          `SELECT id, remote_jid, sender_phone, push_name, raw_content, ai_transcription, created_at
           FROM out_of_hours_queue
           WHERE tenant_id = ? AND status = 'QUEUED'
           ORDER BY created_at ASC`
        )
        .all(config.tenantId) as Array<{
        id: string;
        remote_jid: string;
        sender_phone: string;
        push_name: string | null;
        raw_content: string | null;
        ai_transcription: string | null;
        created_at: string;
      }>;

      if (queuedItems.length === 0) continue;

      // Agrupa por cliente (remote_jid)
      const byJid = new Map<string, typeof queuedItems>();
      for (const item of queuedItems) {
        const list = byJid.get(item.remote_jid) || [];
        list.push(item);
        byJid.set(item.remote_jid, list);
      }

      for (const [remoteJid, items] of byJid.entries()) {
        const firstItem = items[0];
        const senderPhone = firstItem.sender_phone;
        const pushName = firstItem.push_name || 'Cliente';

        // Validação crucial: o profissional (dono) já respondeu esse cliente manualmente?
        const isResponding = isProfessionalActivelyResponding({
          instanceId: config.whatsappInstanceId,
          senderPhone,
          remoteJid,
          sinceMinutes: 120,
        });

        const hasManualOutboundAfterQueue = db
          .prepare(
            `SELECT id FROM hub_message_logs
             WHERE (remote_jid = ? OR sender_phone = ?)
               AND direction = 'OUTBOUND'
               AND (push_name LIKE '%Dono%' OR push_name LIKE '%Você%' OR push_name LIKE '%Profissional%')
               AND created_at >= ?
             LIMIT 1`
          )
          .get(remoteJid, senderPhone, firstItem.created_at);

        if (isResponding || hasManualOutboundAfterQueue) {
          // A profissional já atendeu esse cliente! Não mandar nada do robô.
          for (const it of items) {
            db.prepare(
              `UPDATE out_of_hours_queue SET status = 'SKIPPED_MANUAL_ANSWER', processed_at = datetime('now') WHERE id = ?`
            ).run(it.id);
          }
          skippedCount += items.length;
          console.log(
            `⏭️ [Fila WhatsApp] Ignorando mensagens de ${remoteJid} porque a profissional já respondeu manualmente.`
          );
          continue;
        }

        // Profissional não respondeu: processa a conversa
        const mergedText = items
          .map((i) => (i.ai_transcription || i.raw_content || '').trim())
          .filter(Boolean)
          .join('\n');

        for (const it of items) {
          db.prepare(
            `UPDATE out_of_hours_queue SET status = 'PROCESSED', processed_at = datetime('now') WHERE id = ?`
          ).run(it.id);
        }

        const result = await this.handleClientInterview(config, senderPhone, pushName, mergedText, 'TEXT');
        if (result.replyMessage) {
          await whatsappManager.sendTextMessage({
            instanceId: config.whatsappInstanceId,
            toPhone: senderPhone,
            remoteJid,
            text: result.replyMessage,
          });
        }
        processedCount += items.length;
      }
    }

    return { processed: processedCount, skipped: skippedCount };
  }

  public async confirmPaymentAndSchedule(params: {
    config: EffectiveTenantConfig;
    recordId?: string;
    customerQuery?: string;
  }): Promise<{
    found: boolean;
    recordId?: string;
    customerName?: string;
    customerPhone?: string;
    horario?: string;
  }> {
    const { config, recordId, customerQuery } = params;

    let row:
      | {
          record_id: string;
          form_data: string;
          full_name: string;
          phone_number: string;
        }
      | undefined;

    if (recordId) {
      row = db
        .prepare(
          `SELECT dr.id AS record_id, dr.form_data, c.full_name, c.phone_number
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           WHERE dr.id = ? LIMIT 1`
        )
        .get(recordId) as typeof row;
    } else if (customerQuery) {
      row = db
        .prepare(
          `SELECT dr.id AS record_id, dr.form_data, c.full_name, c.phone_number
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           WHERE dr.tenant_id = ? AND (c.full_name LIKE ? OR c.phone_number LIKE ?)
           ORDER BY dr.updated_at DESC LIMIT 1`
        )
        .get(config.tenantId, `%${customerQuery}%`, `%${customerQuery}%`) as typeof row;

      // Fallback fonético/aproximado para transcrições de voz (ex: "Morganosa" -> "Amor Gatosa")
      if (!row) {
        const candidates = db
          .prepare(
            `SELECT dr.id AS record_id, dr.status, dr.form_data, c.full_name, c.phone_number
             FROM dynamic_records dr
             JOIN customers c ON c.id = dr.customer_id
             WHERE dr.tenant_id = ? AND c.full_name != 'Cliente Ditado'
             ORDER BY CASE WHEN dr.status = 'PENDING_PAYMENT' THEN 0 ELSE 1 END, dr.updated_at DESC
             LIMIT 10`
          )
          .all(config.tenantId) as Array<{
          record_id: string;
          status: string;
          form_data: string;
          full_name: string;
          phone_number: string;
        }>;

        const normQ = customerQuery
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '');

        for (const cand of candidates) {
          const normName = cand.full_name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '');

          // Verifica trigramas em comum (ex: "morganosa" vs "amorgatosa" compartilham "morg", "osa")
          let sharedTrigrams = 0;
          for (let i = 0; i <= normQ.length - 3; i++) {
            const tri = normQ.slice(i, i + 3);
            if (normName.includes(tri)) sharedTrigrams++;
          }
          if (sharedTrigrams >= 2 || normName.includes(normQ) || normQ.includes(normName)) {
            row = cand;
            break;
          }
        }

        // Se ainda não achou pelo nome mas existe apenas 1 ficha pendente de pagamento, assume ela
        if (!row) {
          const pendingOnly = candidates.filter((c) => {
            const fd = JSON.parse(c.form_data || '{}');
            return c.status === 'PENDING_PAYMENT' || (c.status === 'IN_PROGRESS' && fd.preferencia_horario);
          });
          if (pendingOnly.length === 1) {
            row = pendingOnly[0];
          }
        }
      }
    }

    if (!row) {
      return { found: false };
    }

    const fd = JSON.parse(row.form_data || '{}') as Record<string, unknown>;
    const horario = String(fd.preferencia_horario || 'Horário combinado');
    const procedimento = String(fd.queixa_principal || 'Sessão');

    db.prepare(
      `UPDATE dynamic_records SET status = 'COMPLETED', updated_at = datetime('now') WHERE id = ?`
    ).run(row.record_id);

    db.prepare(
      `UPDATE appointments SET status = 'CONFIRMED', updated_at = datetime('now') WHERE record_id = ?`
    ).run(row.record_id);

    await whatsappManager
      .sendTextMessage({
        instanceId: config.whatsappInstanceId,
        toPhone: row.phone_number,
        text:
          `✅ *Pagamento do sinal confirmado!* Muito obrigada 😊\n\n` +
          `Seu agendamento na *${config.tenantName}* já está oficialmente reservado:\n` +
          `💆‍♀️ *Procedimento:* ${procedimento}\n` +
          `🗓️ *Horário:* ${horario}\n\n` +
          `Te esperamos com tudo preparado! Qualquer dúvida até lá é só chamar.`,
      })
      .catch((err) => console.error('[ConfirmPayment] Aviso ao notificar cliente:', err));

    return {
      found: true,
      recordId: row.record_id,
      customerName: row.full_name,
      customerPhone: row.phone_number,
      horario,
    };
  }

  public async handleProfessionalMessage(
    config: EffectiveTenantConfig,
    profPhone: string,
    text: string
  ): Promise<OrchestratorActionResult> {
    const cleanText = text.replace(/^#prof\s+/i, '').trim();
    const lower = cleanText.toLowerCase();

    // 0. CONFIRMAÇÃO DE PAGAMENTO / SINAL PIX PELA PROFISSIONAL (#confirmar Nome ou frase natural por voz/texto)
    const confirmMatch = cleanText.match(
      /(?:^#confirmar\s+|(?:pode\s+)?confirm(?:ei|ar|ado|a)\s+(?:o\s+)?(?:pagamento|sinal|pix|agendamento|hor[aá]rio|atendimento)\s+(?:d[oa]\s+|para\s+)?(?:paciente\s+|cliente\s+)?|(?:recebi\s+o\s+(?:pix|sinal|pagamento)\s+d[oa]\s+)|(?:pix\s+d[oa]\s+))([A-ZÀ-Úa-zà-ú0-9\s]+)/i
    );
    if (/^#confirmar\b/i.test(cleanText) || confirmMatch) {
      const targetName = (
        confirmMatch ? confirmMatch[1] : cleanText.replace(/^#confirmar\s*/i, '')
      )
        .replace(
          /\b(e\s+confirm.*|o\s+hor[aá]rio.*|hor[aá]rio\s+del[ae].*|del[ae]\b|por\s+favor.*|confirmado|recebido|pago|ok|hoje|agora)\b/gi,
          ''
        )
        .replace(/[.,;!?]+$/g, '')
        .trim();

      const confirmed = await this.confirmPaymentAndSchedule({
        config,
        customerQuery: targetName,
      });

      if (!confirmed.found) {
        return {
          mode: 'PROFESSIONAL_QUERY',
          replyMessage: `🔍 Não encontrei agendamento pendente para *"${targetName}"*. Verifique o nome ou confirme em 1 clique na Prancheta Digital.`,
        };
      }

      return {
        mode: 'PROFESSIONAL_QUERY',
        recordId: confirmed.recordId,
        replyMessage:
          `✅ *Sinal Confirmado e Agendamento Efetivado!*\n` +
          `👤 *Cliente:* ${confirmed.customerName}\n` +
          `🗓️ *Horário Reservado:* ${confirmed.horario}\n` +
          `📩 *O cliente já recebeu a confirmação oficial do agendamento no WhatsApp.*`,
      };
    }

    // 0.1. CADASTRO OU ATUALIZAÇÃO DE SERVIÇOS E VALORES VIA WHATSAPP (Texto ou Voz da Profissional)
    // Ex: "#servico Massagem Desportiva | 60 | 150 | 520"
    // Ex: "Quero cadastrar o serviço Ventosaterapia valor 95 reais 45 minutos"
    // Ex: "Alterar o valor da Massagem Relaxante para 130 reais"
    const isServiceUpsertCommand =
      /^#servi[cç]o\b/i.test(cleanText) ||
      /\b(cadastrar\s+(?:o\s+|um\s+)?(?:novo\s+)?servi[cç]o|adicionar\s+(?:o\s+|um\s+)?servi[cç]o|incluir\s+(?:o\s+|um\s+)?servi[cç]o|alterar\s+(?:o\s+)?(?:valor|pre[cç]o)\s+d[aeo]|atualizar\s+(?:o\s+)?(?:valor|pre[cç]o)\s+d[aeo]|novo\s+servi[cç]o\s*:)\b/i.test(
        lower
      );

    if (isServiceUpsertCommand) {
      const catalog = [...config.servicesCatalog];
      let srvName = '';
      let durationMin = 60;
      let priceSingle = 0;
      let pricePkg: number | null = null;

      if (/^#servi[cç]o\b/i.test(cleanText) && cleanText.includes('|')) {
        const parts = cleanText
          .replace(/^#servi[cç]o\s*/i, '')
          .split('|')
          .map((s) => s.trim());
        srvName = parts[0] || '';
        durationMin = parseInt(parts[1]?.replace(/\D/g, '') || '60', 10) || 60;
        priceSingle = Math.round(parseFloat((parts[2] || '0').replace(/[^\d.,]/g, '').replace(',', '.')) || 0);
        if (parts[3]) {
          pricePkg = Math.round(parseFloat(parts[3].replace(/[^\d.,]/g, '').replace(',', '.')) || 0) || null;
        }
      } else {
        // Extração natural por voz ou texto:
        // Extrai duração em minutos (ex: "60 minutos", "45 min")
        const durMatch = cleanText.match(/(\d{2,3})\s*(?:minutos?|min\b)/i);
        if (durMatch) {
          durationMin = parseInt(durMatch[1], 10);
        }

        // Extrai pacote (ex: "pacote 500", "pacote por 480 reais")
        const pkgMatch = cleanText.match(/pacote(?:\s+de\s+4)?(?:\s+por|\s+valor|\s*:)?\s*(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
        if (pkgMatch) {
          pricePkg = Math.round(parseFloat(pkgMatch[1].replace(',', '.')));
        }

        // Remove trecho de pacote e duração para extrair o valor avulso e o nome do serviço
        const withoutPkgAndDur = cleanText
          .replace(/pacote(?:\s+de\s+4)?(?:\s+por|\s+valor|\s*:)?\s*(?:r\$\s*)?\d+(?:[.,]\d+)?(?:\s*reais)?/gi, '')
          .replace(/\d{2,3}\s*(?:minutos?|min\b)/gi, '');

        const priceMatch = withoutPkgAndDur.match(
          /(?:por|valor(?:\s+de)?|pre[cç]o(?:\s+de)?|para|r\$)\s*(?:r\$\s*)?(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*reais/i
        );
        if (priceMatch) {
          priceSingle = Math.round(parseFloat((priceMatch[1] || priceMatch[2]).replace(',', '.')));
        }

        srvName = withoutPkgAndDur
          .replace(/^#servi[cç]o\s*/i, '')
          .replace(
            /^(?:quero\s+)?(?:cadastrar|adicionar|incluir|alterar|atualizar)\s+(?:o\s+|um\s+)?(?:novo\s+)?(?:servi[cç]o|procedimento|valor\s+d[aeo]|pre[cç]o\s+d[aeo])\s*/i,
            ''
          )
          .replace(/(?:no\s+valor.*|valor\s+de.*|por\s+r\$.*|por\s+\d+.*|para\s+r\$.*|para\s+\d+.*|r\$\s*\d+.*|\d+\s*reais.*)/i, '')
          .replace(/[,.;:-]+$/, '')
          .trim();
      }

      if (!srvName || priceSingle <= 0) {
        return {
          mode: 'PROFESSIONAL_QUERY',
          replyMessage:
            `⚠️ Para cadastrar ou atualizar um serviço pelo WhatsApp, informe o *nome* e o *valor*.\n\n` +
            `Exemplos (por texto ou áudio):\n` +
            `• _"Quero cadastrar o serviço Ventosaterapia por 95 reais 45 minutos"_\n` +
            `• _"Alterar o valor da Massagem Relaxante para 130 reais"_\n` +
            `• \`#servico Massagem Desportiva | 60 | 150 | 520\``,
        };
      }

      const normNew = srvName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const existingIdx = catalog.findIndex(
        (s) =>
          s.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') === normNew ||
          s.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .includes(normNew)
      );

      let savedItem;
      const hasExplicitDuration = /(\d{2,3})\s*(?:minutos?|min\b)/i.test(cleanText) || cleanText.includes('|');
      if (existingIdx >= 0) {
        savedItem = {
          ...catalog[existingIdx],
          priceSingle,
          durationMinutes: hasExplicitDuration ? durationMin : catalog[existingIdx].durationMinutes,
          pricePackage4: pricePkg !== null ? pricePkg : catalog[existingIdx].pricePackage4,
        };
        catalog[existingIdx] = savedItem;
      } else {
        savedItem = {
          id: `srv_${Date.now().toString().slice(-5)}`,
          name: srvName,
          durationMinutes: durationMin,
          priceSingle,
          pricePackage4: pricePkg,
        };
        catalog.push(savedItem);
      }

      db.prepare(`UPDATE tenants SET services_catalog = ? WHERE id = ?`).run(
        JSON.stringify(catalog),
        config.tenantId
      );

      const updatedConfig = schemaEngine.getTenantConfig(config.tenantId) || config;
      const calcPreview = schemaEngine.calculateDownPaymentForService(updatedConfig, savedItem.name);

      return {
        mode: 'PROFESSIONAL_QUERY',
        replyMessage:
          `💆‍♀️ *Serviço Cadastrado/Atualizado com Sucesso!*\n\n` +
          `🏷️ *Serviço:* ${savedItem.name} (${savedItem.durationMinutes} min)\n` +
          `💵 *Valor Avulso:* R$ ${savedItem.priceSingle},00\n` +
          (savedItem.pricePackage4 ? `📦 *Pacote (4x):* R$ ${savedItem.pricePackage4},00\n` : '') +
          `💸 *Sinal Calculado (Arredondado):* R$ ${calcPreview.downPaymentAmount || 0},00\n\n` +
          `_O catálogo da empresa e o cálculo automático do sinal já foram atualizados no WhatsApp e no Painel!_`,
      };
    }

    // 0.2. CONSULTA DO CATÁLOGO DE SERVIÇOS E SIMULAÇÃO DO SINAL PELA PROFISSIONAL (#servicos)
    if (
      /^#servi[cç]os\b/i.test(lower) ||
      /\b(quais\s+(?:os\s+)?servi[cç]os\s+cadastrados|meus\s+servi[cç]os|tabela\s+de\s+servi[cç]os|cat[aá]logo\s+de\s+servi[cç]os)\b/i.test(
        lower
      )
    ) {
      return {
        mode: 'PROFESSIONAL_QUERY',
        replyMessage:
          `💆‍♀️ *Catálogo de Serviços & Sinal Arredondado — ${config.tenantName}*\n` +
          `📌 *Regra atual do Sinal:* ${config.downPaymentInfo}\n\n` +
          schemaEngine.formatServicesCatalogText(config, true) +
          `\n\n💡 _Para cadastrar ou alterar um valor por aqui, basta dizer: "Quero cadastrar o serviço Nome por X reais Y minutos" ou "Alterar o valor da Massagem X para Y reais"._`,
      };
    }

    // 1. PRIMEIRO: Verifica se é um REGISTRO DE PÓS-ATENDIMENTO / EVOLUÇÃO DE SESSÃO
    // Ex: "Quero registrar o atendimento que foi feito para Ricardo Messias Batista...", "Atendi o cliente...", "#atendi"
    const isExplicitAttendanceReport =
      /^#atendi\b/i.test(cleanText) ||
      /\b(quero\s+registrar|registrar\s+(?:o\s+|um\s+)?(?:atendimento|evolu[cç][aã]o|sess[aã]o)|atendimento\s+(?:que\s+foi\s+)?(?:feito|realizado)|atendi\s+(?:o|a|paciente|cliente)|realizei\s+(?:o\s+|a\s+)?(?:atendimento|sess[aã]o|massagem)|finalizei\s+(?:o\s+|a\s+)?(?:atendimento|sess[aã]o)|fiz\s+(?:a\s+|o\s+)?(?:massagem|drenagem|sess[aã]o|procedimento|atendimento)|p[oó]s[- ]?atendimento\s+d[oa])\b/i.test(
        lower
      );

    // 1.8. CONSULTA DE RELATÓRIO DO NEGÓCIO (#relatorio, #negocio ou "como está o negócio?")
    if (
      !isExplicitAttendanceReport &&
      (/^#(relatorio|negocio|desempenho)\b/i.test(lower) ||
        /\b(relat[oó]rio|desempenho|como\s+est[aá]\s+o\s+neg[oó]cio|como\s+estamos|faturamento|m[eé]tricas)\b/i.test(
          lower
        ))
    ) {
      const report = schemaEngine.getBusinessSummaryReport(config.tenantId);
      return {
        mode: 'PROFESSIONAL_QUERY',
        replyMessage: report.formattedReportText,
      };
    }

    // 2. SEGUNDO: Se NÃO for registro de atendimento, verifica se é CONSULTA DE AGENDA DA SEMANA (#agenda ou pergunta natural)
    if (
      !isExplicitAttendanceReport &&
      (/^#agenda\b/i.test(lower) ||
        /\b(agenda|agendad[oa]s?|agendamentos?|quais\s+(?:os\s+)?atendimentos?|atendimentos?\s+(?:previstos?|d[ae]\s+semana|para\s+a\s+semana|que\s+tenho|de\s+hoje|de\s+amanh[aã])|tenho\s+para\s+a\s+semana|quem\s+(?:eu\s+)?atendo|hor[aá]rios?\s+marcad|pr[oó]ximos?\s+atendimentos?)\b/i.test(
          lower
        ))
    ) {
      const records = db
        .prepare(
          `SELECT dr.id, dr.status, dr.form_data, dr.updated_at, c.full_name, c.phone_number, c.active_alerts
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           WHERE dr.tenant_id = ? AND c.full_name != 'Cliente Ditado'
           ORDER BY dr.updated_at DESC
           LIMIT 15`
        )
        .all(config.tenantId) as Array<{
        id: string;
        status: string;
        form_data: string;
        updated_at: string;
        full_name: string;
        phone_number: string;
        active_alerts: string;
      }>;

      if (records.length === 0) {
        return {
          mode: 'PROFESSIONAL_QUERY',
          replyMessage: `🗓️ *Atendimentos e Pré-Agendamentos (${config.tenantName})*\n\nAinda não há pacientes pré-agendados ou fichas abertas nesta semana.`,
        };
      }

      const items = records.map((r, idx) => {
        const fd = JSON.parse(r.form_data || '{}') as Record<string, unknown>;
        const alerts = JSON.parse(r.active_alerts || '[]') as string[];
        const proc = fd.queixa_principal || 'A definir';
        const horario = fd.preferencia_horario || 'Aguardando escolha de horário';
        const statusIcon =
          r.status === 'COMPLETED'
            ? '✅ Confirmado'
            : r.status === 'PENDING_PAYMENT'
              ? '💸 Aguardando Sinal Pix'
              : '⏳ Em conversa';
        const alertStr = alerts.length > 0 ? `\n   ⚡ *Alertas:* ${alerts.join(' | ')}` : '';
        return `${idx + 1}. *${r.full_name}* (${statusIcon})\n   💆‍♀️ *Procedimento / Queixa:* ${proc}\n   🕒 *Preferência:* ${horario}${alertStr}`;
      });

      return {
        mode: 'PROFESSIONAL_QUERY',
        replyMessage:
          `🗓️ *Atendimentos e Pré-Agendamentos da Semana — ${config.tenantName}*\n\n` +
          items.join('\n\n') +
          `\n\n💡 _Dica: Envie *#ficha Nome* para ver a ficha completa ou diga *"Atendi o cliente Nome, procedimento..."* para salvar o pós-atendimento._`,
      };
    }

    // 3. TERCEIRO: CONSULTA DE FICHA INDIVIDUAL (#ficha Nome ou "ficha do paciente Nome")
    const naturalFichaMatch = cleanText.match(
      /(?:^#ficha\s+|(?:ficha|hist[oó]rico|resumo|cadastro)\s+(?:d[oa]s?\s+)?(?:paciente\s+|cliente\s+)?)([A-ZÀ-Úa-zà-ú0-9\s]+)/i
    );
    if (!isExplicitAttendanceReport && (/^#ficha\b/i.test(cleanText) || naturalFichaMatch)) {
      const queryTerm = (
        naturalFichaMatch ? naturalFichaMatch[1] : cleanText.replace(/^#ficha\s*/i, '')
      )
        .replace(/\?+$/, '')
        .trim();
      const customer = db
        .prepare(
          `SELECT * FROM customers WHERE tenant_id = ? AND (full_name LIKE ? OR phone_number LIKE ?) ORDER BY last_visit_at DESC LIMIT 1`
        )
        .get(config.tenantId, `%${queryTerm}%`, `%${queryTerm}%`) as
        | { id: string; full_name: string; phone_number: string; active_alerts: string }
        | undefined;

      if (!customer) {
        return {
          mode: 'PROFESSIONAL_QUERY',
          replyMessage: `🔍 Nenhum cadastro encontrado para *"${queryTerm}"* em ${config.tenantName}.`,
        };
      }

      const record = db
        .prepare(
          `SELECT * FROM dynamic_records WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1`
        )
        .get(customer.id) as
        | { id: string; ai_executive_summary: string; status: string }
        | undefined;

      const lastEvolutions = db
        .prepare(
          `SELECT raw_input, session_date FROM session_evolutions WHERE record_id = ? ORDER BY session_date DESC LIMIT 3`
        )
        .all(record?.id || '') as Array<{ raw_input: string; session_date: string }>;

      const historyText =
        lastEvolutions.length > 0
          ? `\n\n🕒 *Histórico de Pós-Atendimento:*\n` +
            lastEvolutions.map((e) => `• [${e.session_date}]: ${e.raw_input}`).join('\n')
          : '\n\n🕒 *Histórico de Pós-Atendimento:* Primeira sessão.';

      return {
        mode: 'PROFESSIONAL_QUERY',
        customerId: customer.id,
        recordId: record?.id,
        replyMessage: `${record?.ai_executive_summary || 'Ficha em andamento.'}${historyText}`,
      };
    }

    // 4. QUARTO: Se não for comando de Pós-Atendimento, fica em silêncio no chat pessoal
    if (!isExplicitAttendanceReport) {
      return {
        mode: 'IGNORED_CASUAL',
        replyMessage: '',
      };
    }

    const cleanDictation = cleanText.replace(/^#(atendi|prof)\s*/i, '').trim();

    const phoneInTextMatch = cleanDictation.match(/\b(\d{10,13})\b/);
    let customer = phoneInTextMatch
      ? (db
          .prepare(`SELECT * FROM customers WHERE tenant_id = ? AND phone_number LIKE ? LIMIT 1`)
          .get(config.tenantId, `%${phoneInTextMatch[1]}%`) as
          | { id: string; full_name: string; phone_number: string }
          | undefined)
      : undefined;

    // Extrai nome completo caso citado na fala (ex: "feito para Ricardo Messias Batista na data")
    const fullNameMatch = cleanDictation.match(
      /(?:feito\s+para\s+|realizado\s+para\s+|atendi\s+|paciente\s+|cliente\s+)(?:o\s+|a\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){0,3})/
    );
    const spokenFullName = fullNameMatch ? fullNameMatch[1].trim() : '';

    if (!customer) {
      const allCustomers = db
        .prepare(
          `SELECT id, full_name, phone_number FROM customers WHERE tenant_id = ? ORDER BY created_at DESC`
        )
        .all(config.tenantId) as Array<{ id: string; full_name: string; phone_number: string }>;

      customer = allCustomers.find((c) =>
        lower.includes(c.full_name.toLowerCase().split(' ')[0])
      );

      if (customer && spokenFullName && spokenFullName.length > customer.full_name.length) {
        db.prepare(`UPDATE customers SET full_name = ? WHERE id = ?`).run(
          spokenFullName,
          customer.id
        );
        customer.full_name = spokenFullName;
      }

      if (!customer) {
        const extractedName = spokenFullName || 'Paciente Registrado';
        const newCustId = `cust_${crypto.randomUUID().slice(0, 8)}`;
        const phoneToUse = phoneInTextMatch
          ? phoneInTextMatch[1]
          : `sem_tel_${Date.now().toString().slice(-4)}`;

        db.prepare(
          `INSERT INTO customers (id, tenant_id, phone_number, full_name, last_visit_at) VALUES (?, ?, ?, ?, datetime('now'))`
        ).run(newCustId, config.tenantId, phoneToUse, extractedName);

        customer = { id: newCustId, full_name: extractedName, phone_number: phoneToUse };
      }
    }

    let record = db
      .prepare(
        `SELECT * FROM dynamic_records WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(customer.id) as { id: string; form_data?: string } | undefined;

    const asksNewSession = /\b(nova\s+sess[aã]o|novo\s+agendamento|agendar\s+novamente|novo\s+contato)\b/i.test(
      lower
    );
    const extractedComplaint = /dor\s+n[ao]\s+lombar|dores?\s+n[ao]\s+lombar/i.test(lower)
      ? 'Dores na lombar (Retorno / Sessão Terapêutica)'
      : cleanDictation.slice(0, 90);

    if (!record) {
      const newRecId = `rec_${crypto.randomUUID().slice(0, 8)}`;
      const initialFormData = {
        queixa_principal: extractedComplaint,
        preferencia_horario: asksNewSession
          ? 'Nova sessão solicitada hoje (A confirmar horário)'
          : 'Atendimento realizado',
      };
      const execSummary =
        `📋 *${config.terminology.recordLabel} — ${customer.full_name}*\n` +
        `• *Queixa / Procedimento:* ${initialFormData.queixa_principal}\n` +
        `• *Status:* ${initialFormData.preferencia_horario}\n` +
        `• *Último relato:* ${cleanDictation}`;

      db.prepare(
        `INSERT INTO dynamic_records (id, tenant_id, customer_id, status, form_data, ai_executive_summary) VALUES (?, ?, ?, 'COMPLETED', ?, ?)`
      ).run(
        newRecId,
        config.tenantId,
        customer.id,
        JSON.stringify(initialFormData),
        execSummary
      );
      record = { id: newRecId };
    } else if (asksNewSession) {
      const currentFd = JSON.parse(record.form_data || '{}') as Record<string, unknown>;
      currentFd.queixa_principal = currentFd.queixa_principal || extractedComplaint;
      currentFd.preferencia_horario = 'Nova sessão solicitada hoje (A confirmar horário)';
      db.prepare(
        `UPDATE dynamic_records SET form_data = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(currentFd), record.id);
    }

    const evolutionId = `evo_${crypto.randomUUID().slice(0, 8)}`;
    const structuredNotes = {
      resumo_sessao: cleanDictation,
      registrado_por: config.terminology.professionalLabel,
      data_hora: new Date().toISOString(),
    };

    db.prepare(
      `INSERT INTO session_evolutions (id, record_id, tenant_id, source, raw_input, structured_notes) VALUES (?, ?, ?, 'PROFESSIONAL_VOICE', ?, ?)`
    ).run(evolutionId, record.id, config.tenantId, cleanDictation, JSON.stringify(structuredNotes));

    db.prepare(`UPDATE customers SET last_visit_at = datetime('now') WHERE id = ?`).run(
      customer.id
    );

    const followupTemplate = config.followupTemplates[0];
    let followupNotice = '';
    if (followupTemplate) {
      const followupId = `flw_${crypto.randomUUID().slice(0, 8)}`;
      const msgFollowup = followupTemplate.messageTemplate.replace(
        '{{clientName}}',
        customer.full_name
      );
      db.prepare(
        `INSERT INTO scheduled_followups (
          id, tenant_id, customer_id, record_id, evolution_id, scheduled_for, status, message_sent
        ) VALUES (?, ?, ?, ?, ?, datetime('now', '+${followupTemplate.triggerAfterHours} hours'), 'PENDING', ?)`
      ).run(followupId, config.tenantId, customer.id, record.id, evolutionId, msgFollowup);

      followupNotice = `\n⏰ *Ficha Viva:* Follow-up pós-sessão agendado para daqui a ${followupTemplate.triggerAfterHours}h.`;
    }

    return {
      mode: 'PROFESSIONAL_DICTATION',
      customerId: customer.id,
      recordId: record.id,
      evolutionId,
      replyMessage: `🎙️ *Pós-Atendimento Registrado com Sucesso!*\n👤 *${config.terminology.clientLabel}:* ${customer.full_name}\n📝 *Evolução / Procedimento:* "${cleanDictation}"${followupNotice}`,
    };
  }

  /**
   * Entrevista Inteligente Contextual + Resposta a Dúvidas e Áudios:
   * - Responde dúvidas abertas (por texto ou áudio) usando a Skill da Empresa e Gemini 3.8 Flash.
   * - Continua o preenchimento natural da ficha sem travar e mesmo após a ficha concluída.
   */
  public async handleClientInterview(
    config: EffectiveTenantConfig,
    clientPhone: string,
    pushName: string,
    userText: string,
    messageType?: string
  ): Promise<OrchestratorActionResult> {
    const customer = db
      .prepare(`SELECT * FROM customers WHERE tenant_id = ? AND phone_number = ?`)
      .get(config.tenantId, clientPhone) as
      | { id: string; full_name: string; active_alerts: string; shadow_memory?: string }
      | undefined;

    let activeCustomer = customer;
    if (!activeCustomer) {
      const newCustomerId = `cust_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(
        `INSERT INTO customers (id, tenant_id, phone_number, full_name, shadow_memory, last_visit_at) VALUES (?, ?, ?, ?, '', datetime('now'))`
      ).run(newCustomerId, config.tenantId, clientPhone, pushName);
      activeCustomer = { id: newCustomerId, full_name: pushName, active_alerts: '[]', shadow_memory: '' };
    }

    // Carrega o estado estruturado da agenda e pacotes salvos no banco de dados (SEM AMNÉSIA)
    const agendaContext = schemaEngine.getCustomerAgendaAndPackages(
      config.tenantId,
      activeCustomer.id
    );
    const hasRemainingPackage = agendaContext.activePackages.some((p) => p.sessionsRemaining > 0);

    const existingRecord = db
      .prepare(
        `SELECT * FROM dynamic_records WHERE tenant_id = ? AND customer_id = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1`
      )
      .get(config.tenantId, activeCustomer.id) as
      | {
          id: string;
          status: string;
          current_step_state: string;
          form_data: string;
        }
      | undefined;

    const currentStepObj = existingRecord
      ? (JSON.parse(existingRecord.current_step_state || '{}') as {
          currentFieldKey?: string;
          lastAskedFieldKey?: string;
          context?: string;
          packageId?: string;
        })
      : {};

    const recentLogs = db
      .prepare(
        `SELECT direction, COALESCE(ai_transcription, raw_content) AS content FROM hub_message_logs WHERE sender_phone = ? ORDER BY created_at DESC LIMIT 8`
      )
      .all(clientPhone) as Array<{ direction: string; content: string }>;

    const recentHistoryArray: Array<{ role: 'user' | 'model'; text: string }> = recentLogs
      .slice()
      .reverse()
      .map((l) => ({
        role: l.direction === 'INBOUND' ? ('user' as const) : ('model' as const),
        text: l.content || '',
      }));

    const recentHistoryText = recentHistoryArray
      .map((l) => `${l.role === 'user' ? 'Cliente' : 'Atendente'}: ${l.text}`)
      .join('\n');

    const intent = schemaEngine.classifyConversationIntent({
      userText,
      messageType,
      hasActiveInProgressRecord:
        existingRecord?.status === 'IN_PROGRESS' || existingRecord?.status === 'PENDING_PAYMENT',
      hasCompletedRecord: existingRecord?.status === 'COMPLETED',
      hasActivePackageWithRemainingSessions: hasRemainingPackage,
      currentStepFieldKey: currentStepObj.currentFieldKey || 'preferencia_horario',
      recentMessages: recentLogs,
    });

    if (intent === 'CASUAL_CHAT_IGNORE') {
      return {
        mode: 'IGNORED_CASUAL',
        replyMessage: '',
      };
    }

    // 1. Consulta factual de agenda e pacotes guardados no sistema: responde imediatamente do banco de dados!
    if (intent === 'AGENDA_STATUS_INQUIRY') {
      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: existingRecord?.id,
        recordStatus: existingRecord?.status || 'COMPLETED',
        activeAlerts: [],
        formData: JSON.parse(existingRecord?.form_data || '{}'),
        replyMessage: agendaContext.summaryText,
      };
    }

    // Se o cliente com pacote escolhe agendar a próxima sessão do seu pacote:
    const isNextPackageSessionChoice =
      hasRemainingPackage &&
      /\b(pr[oó]xima|sess[aã]o\s*2|segunda\s+sess[aã]o|sess[aã]o\s*3|sess[aã]o\s*4|pra\s+mim|mesmo\s+pacote|minha\s+sess[aã]o)\b/i.test(
        userText
      );

    // 2. Pedido de agendamento genérico quando o cliente já possui pacote ativo com saldo de sessões:
    if (intent === 'PACKAGE_SESSION_BOOKING_OR_NEW' && !isNextPackageSessionChoice) {
      const activePkg = agendaContext.activePackages.find((p) => p.sessionsRemaining > 0);
      if (activePkg) {
        const firstApt = agendaContext.activeAppointments[0];
        const aptInfo = firstApt
          ? ` (sua 1ª sessão está confirmada para *${firstApt.dayLabel} às ${firstApt.startTime}*)`
          : '';

        return {
          mode: 'CLIENT_INTERVIEW',
          customerId: activeCustomer.id,
          recordId: existingRecord?.id,
          recordStatus: existingRecord?.status || 'COMPLETED',
          activeAlerts: [],
          formData: JSON.parse(existingRecord?.form_data || '{}'),
          replyMessage:
            `Você possui o *${activePkg.serviceName}* com *${activePkg.sessionsRemaining} sessões restantes* a agendar${aptInfo} 😊\n\n` +
            `Você gostaria de agendar a sua próxima sessão do pacote, marcar outro procedimento ou agendar para outra pessoa?`,
        };
      }
    }

    if (intent === 'CATALOG_OR_PRICE_QUERY') {
      return {
        mode: 'CLIENT_INTERVIEW',
        replyMessage:
          `Aqui na *${config.tenantName}* trabalhamos com sessões avulsas ou pacotes de 4 sessões:\n\n` +
          schemaEngine.formatServicesCatalogText(config, false) +
          `\n\nQual delas você gostaria de agendar? 😊`,
      };
    }

    // Busca histórico de sessões anteriores (evoluções) e fichas anteriores para memória de cliente recorrente!
    const pastEvolutions = db
      .prepare(
        `SELECT raw_input, session_date FROM session_evolutions
         WHERE record_id IN (SELECT id FROM dynamic_records WHERE customer_id = ?)
         ORDER BY session_date DESC LIMIT 3`
      )
      .all(activeCustomer.id) as Array<{ raw_input: string; session_date: string }>;

    const allCustomerRecords = db
      .prepare(
        `SELECT form_data FROM dynamic_records WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 5`
      )
      .all(activeCustomer.id) as Array<{ form_data: string }>;

    // Mescla APENAS dados clínicos persistentes já conhecidos do cliente (alergias e histórico de saúde)
    // para NUNCA repetir perguntas já respondidas, mas sempre perguntar qual procedimento e horário ele quer hoje!
    const inheritedProfileData: Record<string, unknown> = {};
    for (const r of allCustomerRecords) {
      const fd = JSON.parse(r.form_data || '{}') as Record<string, unknown>;
      for (const persistentKey of ['alergias', 'historico_saude']) {
        if (
          inheritedProfileData[persistentKey] === undefined &&
          fd[persistentKey] !== undefined &&
          fd[persistentKey] !== null &&
          fd[persistentKey] !== ''
        ) {
          inheritedProfileData[persistentKey] = fd[persistentKey];
        }
      }
    }

    let record = existingRecord;

    if (
      !record ||
      record.status === 'CANCELLED' ||
      (record.status === 'COMPLETED' &&
        (intent === 'SERVICE_OR_BOOKING_REQUEST' || isNextPackageSessionChoice))
    ) {
      const newRecordId = `rec_${crypto.randomUUID().slice(0, 8)}`;
      const activePkg = agendaContext.activePackages.find((p) => p.sessionsRemaining > 0);

      let initialFormData = { ...inheritedProfileData };
      let initialStep: Record<string, unknown>;

      if (isNextPackageSessionChoice && activePkg) {
        const nextSessionNum = activePkg.sessionsCompleted + activePkg.sessionsScheduled + 1;
        initialFormData.queixa_principal = `${activePkg.serviceName} (Sessão ${nextSessionNum} de ${activePkg.totalSessions})`;
        initialFormData.para_quem_e_nivel_dor = `Para si mesmo(a) — Sessão ${nextSessionNum} do Pacote`;
        initialStep = {
          currentFieldKey: 'preferencia_horario',
          lastAskedFieldKey: 'preferencia_horario',
          greeted: true,
          packageId: activePkg.id,
          sessionNumber: nextSessionNum,
        };
      } else {
        const firstField = config.formSchema[0];
        initialStep = { currentFieldKey: firstField?.fieldKey || null, greeted: true };
      }

      db.prepare(
        `INSERT INTO dynamic_records (
          id, tenant_id, customer_id, status, current_step_state, form_data
        ) VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?)`
      ).run(
        newRecordId,
        config.tenantId,
        activeCustomer.id,
        JSON.stringify(initialStep),
        JSON.stringify(initialFormData)
      );

      record = {
        id: newRecordId,
        status: 'IN_PROGRESS',
        current_step_state: JSON.stringify(initialStep),
        form_data: JSON.stringify(initialFormData),
      };

      if (isNextPackageSessionChoice && activePkg) {
        const nextSessionNum = activePkg.sessionsCompleted + activePkg.sessionsScheduled + 1;
        return {
          mode: 'CLIENT_INTERVIEW',
          customerId: activeCustomer.id,
          recordId: newRecordId,
          recordStatus: 'IN_PROGRESS',
          activeAlerts: [],
          formData: initialFormData,
          replyMessage: `Perfeito! Qual o melhor dia e horário para eu agendar a sua ${nextSessionNum}ª sessão do pacote? 😊`,
        };
      }
    }

    const existingFormData = {
      ...inheritedProfileData,
      ...(JSON.parse(record.form_data || '{}') as Record<string, unknown>),
    };
    // Se preferencia_horario anterior não tinha hora exata (ex: "Próxima terça"), move para partialSchedule para exigir a escolha da hora!
    const stepState = JSON.parse(record.current_step_state || '{}') as {
      currentFieldKey?: string;
      lastAskedFieldKey?: string;
      partialSchedule?: { dayLabel?: string; dateIso?: string; period?: string };
    };

    if (
      existingFormData.preferencia_horario &&
      !schemaEngine.hasExplicitHour(String(existingFormData.preferencia_horario))
    ) {
      const recovered = schemaEngine.parseScheduleComponents(
        String(existingFormData.preferencia_horario),
        stepState.partialSchedule
      );
      stepState.partialSchedule = {
        dayLabel: recovered.dayLabel || stepState.partialSchedule?.dayLabel,
        dateIso: recovered.dateIso || stepState.partialSchedule?.dateIso,
        period: recovered.period || stepState.partialSchedule?.period,
      };
      delete existingFormData.preferencia_horario;
    }

    const firstName = activeCustomer.full_name.split(' ')[0] || activeCustomer.full_name;

    // Regra rígida de vestimenta e proibição de nudez (solicitação direta do usuário)
    const normUser = userText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const isAskingNudityOrSexual =
      /\b(nu|nua|pelad[ao]|sem\s+roupa|tirar\s+tudo|sem\s+nada|final\s+feliz|massagem\s+completa|de\s+toalha|so\s+de\s+toalha)\b/i.test(
        normUser
      ) ||
      /\b(que\s+roupa|qual\s+roupa|como\s+devo\s+ir|o\s+que\s+vestir|roupa\s+usar)\b/i.test(
        normUser
      );

    if (isAskingNudityOrSexual) {
      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: record.status,
        activeAlerts: schemaEngine.evaluateAlerts(config, existingFormData),
        formData: existingFormData,
        replyMessage: this.sanitizeNaturalReply(
          'O meu atendimento é estritamente massoterapia terapêutica profissional! A vestimenta obrigatória é bermuda leve para homens e calcinha e sutiã para mulheres.',
          clientPhone,
          firstName
        ),
      };
    }

    const customerProfile = {
      fullName: activeCustomer.full_name,
      firstName,
      isReturningCustomer: pastEvolutions.length > 0 || allCustomerRecords.length > 1,
      pastEvolutionsSummary:
        pastEvolutions.length > 0
          ? pastEvolutions.map((e) => `[${e.session_date}]: ${e.raw_input}`).join(' | ')
          : undefined,
      activeAppointmentsSummary: agendaContext.summaryText,
    };

    // Obtenção dos serviços relacionais do tenant
    const relationalServices = this.getTenantRelationalServices(config.tenantId);

    // Constrói prompt de sistema dinâmico sem acoplamentos rígidos
    const dynamicSystemInstruction = this.buildDynamicSystemPrompt(
      config,
      relationalServices,
      {
        phone_number: clientPhone,
        full_name: activeCustomer.full_name,
        shadow_memory: (activeCustomer as any).shadow_memory,
      },
      agendaContext.summaryText
    );

    // Chamada agnóstica ao Gemini com Tools e Sliding Window de 8 mensagens
    let aiResponseText = '';
    if (config.aiApiKey || geminiService.isConfigured()) {
      try {
        const geminiResult = await geminiService.processInputAndExtractJson({
          systemInstruction: dynamicSystemInstruction,
          text: userText,
          recentHistory: recentHistoryArray,
          tools: this.getFunctionDeclarations(),
          apiKeyOverride: config.aiApiKey,
          modelOverride: config.aiModel,
        });

        if (geminiResult.tokensUsed > 0) {
          this.incrementTenantTokensUsed(config.tenantId, geminiResult.tokensUsed);
        }

        if (geminiResult.conversationalReply) {
          aiResponseText = geminiResult.conversationalReply;
        }

        // Executa ferramentas disparadas pela IA
        if (geminiResult.functionCalls && geminiResult.functionCalls.length > 0) {
          for (const fc of geminiResult.functionCalls) {
            if (fc.name === 'salvar_anamnese_concluida') {
              const q = fc.args.queixa_principal;
              const a = fc.args.alergias;
              const c = fc.args.condicoes_medicas;
              if (q) updatedFormData.queixa_principal = q;
              if (a) updatedFormData.alergias_restricoes = a;
              if (c) updatedFormData.condicoes_especiais = c;

              const memoryPiece = `Queixa: ${q || 'N/D'}. Alergias: ${a || 'Nenhuma'}. Restrições: ${c || 'Nenhuma'}.`;
              db.prepare(`UPDATE customers SET shadow_memory = ? WHERE id = ?`).run(
                memoryPiece,
                activeCustomer.id
              );
            } else if (fc.name === 'confirmar_agendamento') {
              const srv = fc.args.servico_nome || 'Massagem Relaxante';
              const dt = fc.args.data_hora_texto || '';
              if (dt) {
                updatedFormData.preferencia_horario = dt;
              }
              if (srv) {
                updatedFormData.queixa_principal = srv;
              }
            }
          }
        }
      } catch (err) {
        console.warn('[ConversationOrchestrator] Falha no Gemini agnóstico, seguindo com fluxo de regras:', err);
      }
    }

    const extractionOutcome = await schemaEngine.extractFieldsFromInput({
      config,
      userText,
      currentStepFieldKey: stepState.currentFieldKey,
      existingData: existingFormData,
      recentHistory: recentHistoryText,
      customerProfile,
    });

    const updatedFormData = extractionOutcome.updatedData;

    // ========================================================================
    // MOTOR DE AGENDA INTELIGENTE:
    // Garante que o agendamento tenha DIA + HORA EXATA (respeitando buffer entre atendimentos e dias/horários de funcionamento)
    // ========================================================================
    const parsedSched = schemaEngine.parseScheduleComponents(userText, stepState.partialSchedule);
    let agendaReplyOverride = '';

    if (parsedSched.dayLabel || parsedSched.period || parsedSched.exactTime) {
      stepState.partialSchedule = {
        dayLabel: parsedSched.dayLabel || stepState.partialSchedule?.dayLabel,
        dateIso: parsedSched.dateIso || stepState.partialSchedule?.dateIso,
        period: parsedSched.period || stepState.partialSchedule?.period,
      };
    } else if (
      /\b(?:n[aã]o\s+(?:posso|consigo|d[aá]|vou|quero)|menos|exceto|sem\s+ser)\b/i.test(userText) ||
      /\bs[oó]\s+n[aã]o\b/i.test(userText)
    ) {
      // Se o cliente acabou de negar dias (ex: "Eu só não posso domingo e segunda"), limpa o agendamento parcial anterior!
      stepState.partialSchedule = undefined;
    }

    const serviceCalc = schemaEngine.calculateDownPaymentForService(
      config,
      String(updatedFormData.queixa_principal || '')
    );
    const serviceDuration = serviceCalc.matchedService?.durationMinutes || 60;

    // Se o cliente informou Dia + Hora Exata (ou escolheu a Hora Exata após já ter informado o Dia):
    if (stepState.partialSchedule?.dayLabel && stepState.partialSchedule?.dateIso && parsedSched.exactTime) {
      const avail = schemaEngine.checkAgendaAvailability({
        tenantId: config.tenantId,
        dateIso: stepState.partialSchedule.dateIso,
        dayLabel: stepState.partialSchedule.dayLabel,
        period: parsedSched.period || (stepState.partialSchedule.period as any),
        requestedTime: parsedSched.exactTime,
        durationMinutes: serviceDuration,
        excludeRecordId: record.id,
      });

      if (avail.isDayClosed) {
        delete updatedFormData.preferencia_horario;
        stepState.partialSchedule = undefined;
        agendaReplyOverride = `${avail.closedReason || 'Não realizo atendimentos neste dia.'} Qual outro dia fica bom para você?`;
      } else if (!avail.isRequestedTimeFree) {
        delete updatedFormData.preferencia_horario;
        const sugestoes =
          avail.availableSlots.length > 0
            ? `Nesse dia tenho livre às *${avail.availableSlots.join('*, *')}*. Algum desses horários dá certo para você?`
            : `Você prefere tentar outro turno ou outro dia?`;
        const motivo =
          avail.reason ||
          `Poxa, às *${parsedSched.exactTime}* já tenho um atendimento agendado ou a maca está em higienização/preparo! 😅`;
        agendaReplyOverride = `${motivo} ${sugestoes}`;
      } else {
        updatedFormData.preferencia_horario = `${stepState.partialSchedule.dayLabel} às ${parsedSched.exactTime}`;
        const activePkg = agendaContext.activePackages.find((p) => p.sessionsRemaining > 0);
        const pkgSessionNum =
          (stepState as any).sessionNumber ||
          (activePkg ? activePkg.sessionsCompleted + activePkg.sessionsScheduled + 1 : undefined);

        schemaEngine.saveAppointmentSlot({
          tenantId: config.tenantId,
          customerId: activeCustomer.id,
          recordId: record.id,
          packageId: (stepState as any).packageId || activePkg?.id,
          sessionNumber: pkgSessionNum,
          serviceName: String(updatedFormData.queixa_principal || 'Sessão de Massoterapia'),
          dateIso: stepState.partialSchedule.dateIso,
          dayLabel: stepState.partialSchedule.dayLabel,
          startTime: parsedSched.exactTime,
          durationMinutes: serviceDuration,
          status: config.requireDownPayment && config.pixKey ? 'PENDING_PAYMENT' : 'CONFIRMED',
        });
      }
    } else if (
      stepState.partialSchedule?.dayLabel &&
      stepState.partialSchedule?.dateIso &&
      stepState.partialSchedule?.period &&
      !parsedSched.exactTime &&
      !updatedFormData.preferencia_horario
    ) {
      // Cliente já falou o DIA e o TURNO, mas ainda NÃO falou a HORA!
      delete updatedFormData.preferencia_horario;
      const avail = schemaEngine.checkAgendaAvailability({
        tenantId: config.tenantId,
        dateIso: stepState.partialSchedule.dateIso,
        dayLabel: stepState.partialSchedule.dayLabel,
        period: stepState.partialSchedule.period as any,
        durationMinutes: serviceDuration,
        excludeRecordId: record.id,
      });

      if (avail.isDayClosed) {
        stepState.partialSchedule = undefined;
        agendaReplyOverride = `${avail.closedReason || 'Não realizo atendimentos neste dia.'} Qual outro dia fica bom para você?`;
      } else {
        const turnoNome =
          stepState.partialSchedule.period === 'MANHA'
            ? 'de manhã'
            : stepState.partialSchedule.period === 'TARDE'
              ? 'à tarde'
              : 'à noite';
        const diaCurto = stepState.partialSchedule.dayLabel.split(' ')[0].toLowerCase();
        const diaFormatado = /^(hoje|amanh[aã])$/i.test(diaCurto)
          ? diaCurto.charAt(0).toUpperCase() + diaCurto.slice(1)
          : /^(s[aá]bado|domingo)$/i.test(diaCurto)
            ? `No ${diaCurto}`
            : `Na ${diaCurto}`;
        agendaReplyOverride =
          avail.availableSlots.length > 0
            ? `${diaFormatado} ${turnoNome} tenho livre às *${avail.availableSlots.join('*, *')}*. Qual desses horários fica melhor pra você? 😊`
            : `Poxa, ${diaFormatado.toLowerCase()} ${turnoNome} a agenda já está cheia! Prefere olhar outro turno ou outro dia?`;
      }
    } else if (
      stepState.partialSchedule?.dayLabel &&
      !stepState.partialSchedule?.period &&
      !parsedSched.exactTime &&
      !updatedFormData.preferencia_horario &&
      /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|hoje|amanh[aã])\b/i.test(userText)
    ) {
      // Cliente falou apenas o DIA, sem turno e sem hora:
      delete updatedFormData.preferencia_horario;
      const checkDay = schemaEngine.checkAgendaAvailability({
        tenantId: config.tenantId,
        dateIso: stepState.partialSchedule.dateIso || '',
        dayLabel: stepState.partialSchedule.dayLabel,
        durationMinutes: serviceDuration,
        excludeRecordId: record.id,
      });

      if (checkDay.isDayClosed) {
        stepState.partialSchedule = undefined;
        agendaReplyOverride = `${checkDay.closedReason || 'Não realizo atendimentos neste dia.'} Qual outro dia fica bom para você?`;
      } else {
        const diaCurto = stepState.partialSchedule.dayLabel.split(' ')[0].toLowerCase();
        const diaFormatado = /^(hoje|amanh[aã])$/i.test(diaCurto)
          ? diaCurto
          : /^(s[aá]bado|domingo)$/i.test(diaCurto)
            ? `no ${diaCurto}`
            : `na ${diaCurto}`;
        agendaReplyOverride = `Combinado! E ${diaFormatado} você prefere de manhã ou à tarde? 😊`;
      }
    } else if (
      !stepState.partialSchedule?.dayLabel &&
      stepState.partialSchedule?.period &&
      !parsedSched.exactTime &&
      !updatedFormData.preferencia_horario
    ) {
      // Cliente falou apenas o TURNO, sem dizer qual dia da semana:
      delete updatedFormData.preferencia_horario;
      const turnoNome =
        stepState.partialSchedule.period === 'MANHA'
          ? 'de manhã'
          : stepState.partialSchedule.period === 'TARDE'
            ? 'à tarde'
            : 'à noite';
      agendaReplyOverride = `Perfeito! E qual dia da semana fica melhor pra você vir ${turnoNome}? 😊`;
    }

    const activeAlerts = schemaEngine.evaluateAlerts(config, updatedFormData);
    const executiveSummary = schemaEngine.buildExecutiveSummary(
      config,
      activeCustomer.full_name,
      updatedFormData,
      activeAlerts
    );

    const nextField = schemaEngine.getNextMissingField(config, updatedFormData);

    // Se o cliente está escolhendo turno/horário da agenda e ainda falta definir a hora exata, prioriza a resposta curta da Agenda!
    if (agendaReplyOverride && !extractionOutcome.isClientQuestion) {
      const partialState = {
        currentFieldKey: nextField ? nextField.fieldKey : 'preferencia_horario',
        lastAskedFieldKey: 'preferencia_horario',
        partialSchedule: stepState.partialSchedule,
      };
      db.prepare(
        `UPDATE dynamic_records 
         SET status = 'IN_PROGRESS', current_step_state = ?, form_data = ?, ai_executive_summary = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(JSON.stringify(partialState), JSON.stringify(updatedFormData), executiveSummary, record.id);

      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: 'IN_PROGRESS',
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(agendaReplyOverride, clientPhone, firstName),
      };
    }

    // Se o cliente fez uma pergunta aberta (ex: "Qual endereço?", "Como funciona?"), responde de forma curta,
    // mas garante que se todos os campos já foram preenchidos (!nextField), o status já vá para PENDING_PAYMENT!
    if (
      (extractionOutcome.isClientQuestion || intent === 'CLIENT_QUESTION_OR_DOUBT') &&
      extractionOutcome.conversationalReply
    ) {
      const needsPix = Boolean(config.requireDownPayment && config.pixKey);
      const effectiveStatus =
        !nextField && record.status === 'IN_PROGRESS'
          ? needsPix
            ? 'PENDING_PAYMENT'
            : 'COMPLETED'
          : record.status;

      db.prepare(
        `UPDATE dynamic_records 
         SET status = ?, form_data = ?, current_step_state = ?, ai_executive_summary = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        effectiveStatus,
        JSON.stringify(updatedFormData),
        JSON.stringify(stepState),
        executiveSummary,
        record.id
      );

      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: effectiveStatus,
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(extractionOutcome.conversationalReply, clientPhone, firstName),
      };
    }

    // Se a ficha já estava COMPLETED e o cliente mandou outra mensagem/pergunta (mesmo sem Gemini)
    if (record.status === 'COMPLETED' && !nextField && intent === 'CLIENT_QUESTION_OR_DOUBT') {
      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: 'COMPLETED',
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(
          aiResponseText ||
            extractionOutcome.conversationalReply ||
            `Aqui no *${config.tenantName}* eu atendo com hora marcada, em ambiente individual e acolhedor, trabalhando exclusivamente com as técnicas terapêuticas do meu catálogo. Ficou alguma dúvida específica sobre o seu atendimento? 😊`,
          clientPhone,
          firstName
        ),
      };
    }

    // Se a ficha está aguardando confirmação de pagamento do sinal (PENDING_PAYMENT)
    // O cliente NUNCA consegue auto-confirmar o agendamento; apenas a profissional pode aprovar!
    if (
      record.status === 'PENDING_PAYMENT' &&
      /\b(paguei|pago|fiz\s+o\s+pix|mandei\s+o\s+pix|enviei\s+o\s+pix|comprovante|transferi|j[aá]\s+enviei)\b/i.test(
        userText
      )
    ) {
      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: 'PENDING_PAYMENT',
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(
          `Recebido! 🙏 Já encaminhei para conferência do pagamento e, assim que eu confirmar o recebimento do sinal na conta, te envio a confirmação oficial do seu agendamento por aqui 😊`,
          clientPhone,
          firstName
        ),
      };
    }

    const needsPixDownPayment = Boolean(config.requireDownPayment && config.pixKey);
    const newStatus = nextField
      ? 'IN_PROGRESS'
      : needsPixDownPayment && record.status !== 'COMPLETED'
        ? 'PENDING_PAYMENT'
        : 'COMPLETED';

    const nextStepState = {
      currentFieldKey: nextField ? nextField.fieldKey : null,
      lastAskedFieldKey: nextField ? nextField.fieldKey : null,
      partialSchedule: stepState.partialSchedule,
      completedAt: nextField ? null : new Date().toISOString(),
    };

    const consentSignature = !nextField
      ? JSON.stringify({
          accepted: true,
          phone: clientPhone,
          timestamp: new Date().toISOString(),
          hash: crypto
            .createHash('sha256')
            .update(`${activeCustomer.id}:${JSON.stringify(updatedFormData)}`)
            .digest('hex')
            .slice(0, 16),
        })
      : '{}';

    db.prepare(
      `UPDATE dynamic_records 
       SET status = ?, current_step_state = ?, form_data = ?, ai_executive_summary = ?, consent_signature = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      newStatus,
      JSON.stringify(nextStepState),
      JSON.stringify(updatedFormData),
      executiveSummary,
      consentSignature,
      record.id
    );

    db.prepare(
      `UPDATE customers SET active_alerts = ?, last_visit_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(activeAlerts), activeCustomer.id);

    if (nextField) {
      const greetingPrefix = schemaEngine.isGreetingOnlyText(userText)
        ? `Olá! Tudo bem com você? 😊 `
        : '';
      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: 'IN_PROGRESS',
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(
          aiResponseText || extractionOutcome.conversationalReply || `${greetingPrefix}${nextField.questionPrompt}`,
          clientPhone,
          firstName
        ),
      };
    }

    if (newStatus === 'PENDING_PAYMENT') {
      const calc = schemaEngine.calculateDownPaymentForService(
        config,
        String(updatedFormData.queixa_principal || '')
      );
      const horarioEscolhido = String(updatedFormData.preferencia_horario || 'horário combinado');

      const valorSinalBlock =
        calc.downPaymentAmount !== null
          ? `💰 *Valor do Sinal (Arredondado):* R$ ${calc.downPaymentAmount},00` +
            (calc.downPaymentPercent !== null && calc.basePrice !== null
              ? ` _(${calc.downPaymentPercent}% de R$ ${calc.basePrice},00 — ${calc.matchedService?.name || 'Sessão'})_\n`
              : '\n')
          : `💰 *Sinal:* ${config.downPaymentInfo}\n`;

      return {
        mode: 'CLIENT_INTERVIEW',
        customerId: activeCustomer.id,
        recordId: record.id,
        recordStatus: 'PENDING_PAYMENT',
        activeAlerts,
        formData: updatedFormData,
        replyMessage: this.sanitizeNaturalReply(
          `Perfeito! Para eu garantir e confirmar a reserva do seu horário (*${horarioEscolhido}*), eu peço um sinal via Pix 😊\n\n` +
            valorSinalBlock +
            `🔑 *Chave Pix:* ${config.pixKey}\n\n` +
            `Assim que realizar o pagamento, pode me enviar o comprovante por aqui mesmo. Assim que eu validar o recebimento, seu horário fica oficialmente confirmado!`,
          clientPhone,
          firstName
        ),
      };
    }

    return {
      mode: 'CLIENT_INTERVIEW',
      customerId: activeCustomer.id,
      recordId: record.id,
      recordStatus: 'COMPLETED',
      activeAlerts,
      formData: updatedFormData,
      replyMessage: this.sanitizeNaturalReply(
        `Perfeito, já deixei seu horário pré-reservado aqui pra você! Te espero então, qualquer coisa até lá é só me chamar 😊`,
        clientPhone,
        firstName
      ),
    };
  }

  /**
   * Sanitiza a resposta para garantir estrita fidelidade às regras de tom de voz:
   * 1. Elimina vocativos íntimos/carinhosos ("meu bem", "amor", etc.).
   * 2. Converte expressões no plural para 1ª pessoa do singular quando configurado assim.
   * 3. Proíbe expressamente "a seu critério" em vestimenta/nudez.
   * 4. Remove repetições desnecessárias do nome do cliente em mensagens consecutivas.
   */
  private sanitizeNaturalReply(
    reply: string,
    customerPhone: string,
    customerFirstName: string
  ): string {
    let text = (reply || '').trim();
    if (!text) return '';

    // 1. Elimina vocativos íntimos/carinhosos
    text = text.replace(
      /\b(meu\s+bem|meu\s+amor|meu\s+anjo|anjo|querido|querida|lindo|linda|flor|cora[cç][aã]o)\b/gi,
      ''
    );

    // 2. Transforma plural da clínica em 1ª pessoa do singular (atendimento individual)
    text = text
      .replace(/\btrabalhamos\b/gi, 'eu trabalho')
      .replace(/\busamos\b/gi, 'eu uso')
      .replace(/\bnossa\s+cl[ií]nica\b/gi, 'meu espaço')
      .replace(/\bnossos\s+atendimentos\b/gi, 'meus atendimentos')
      .replace(/\bte\s+esperamos\b/gi, 'te espero')
      .replace(/\boferecemos\b/gi, 'eu ofereço');

    // 3. Proíbe expressamente "a seu critério" para roupas / nudez
    text = text.replace(
      /\bfica\s+a\s+(?:seu\s+)?crit[eé]rio\b/gi,
      'A vestimenta obrigatória é bermuda leve para homens e calcinha e sutiã para mulheres'
    );

    // 4. Evita repetição excessiva do nome da pessoa em mensagens consecutivas
    const cleanPhone = customerPhone.replace(/\D/g, '');
    const lastOutbound = db
      .prepare(
        `SELECT raw_content FROM hub_message_logs
         WHERE sender_phone = ? AND direction = 'OUTBOUND'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(cleanPhone) as { raw_content?: string } | undefined;

    if (customerFirstName && lastOutbound?.raw_content) {
      const nameRegex = new RegExp(`\\b${customerFirstName}\\b`, 'i');
      if (nameRegex.test(lastOutbound.raw_content)) {
        // Remove "Diego, ", "Oi Diego, ", "Perfeito Diego, " no início
        text = text.replace(
          new RegExp(`^(?:oi|ol[aá]|perfeito|maravilha|claro|desculpa|perd[aã]o)?\\s*,?\\s*${customerFirstName}[,! ]*`, 'i'),
          ''
        );
        // Remove ", Diego" no final
        text = text.replace(new RegExp(`[, ]+${customerFirstName}([!.]*)$`, 'i'), '$1');
      }
    }

    // Limpa pontuações duplicadas e espaços extras resultantes de remoção
    text = text
      .replace(/\s+,/g, ',')
      .replace(/,\s*,/g, ',')
      .replace(/!\s*!/g, '!')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }

    return text;
  }

  /**
   * Constrói o Prompt Dinâmico de Sistema conforme o Playbook Multi-Tenant:
   * Sem hardcodes de pessoa ou empresa, lendo serviços da tabela relacional e
   * respeitando as regras éticas, persona e histórico prévio.
   */
  public buildDynamicSystemPrompt(
    tenant: EffectiveTenantConfig,
    services: Array<{
      id: string;
      name: string;
      description?: string | null;
      duration_min: number;
      price_single: number;
      price_package_4x?: number | null;
      recommended_deposit?: number | null;
    }>,
    customer: { phone_number: string; full_name: string; shadow_memory?: string },
    agendaStatusSummary?: string
  ): string {
    const catalogText = services
      .map(
        (s) =>
          `- ${s.name} (${s.duration_min} min): R$ ${s.price_single.toFixed(2)} avulsa${
            s.price_package_4x ? ` | Pacote 4x: R$ ${s.price_package_4x.toFixed(2)}` : ''
          } (Sinal recomendado 30%: R$ ${(s.recommended_deposit || s.price_single * 0.3).toFixed(2)})${
            s.description ? ` - ${s.description}` : ''
          }`
      )
      .join('\n');

    const address = tenant.brandingAddress || tenant.tenantName;
    const hours =
      tenant.agendaConfig.openTime && tenant.agendaConfig.closeTime
        ? `Segunda a Sábado, das ${tenant.agendaConfig.openTime} às ${tenant.agendaConfig.closeTime}`
        : 'Segunda a Sábado, das 08:30 às 19:30';

    return `
Você é a própria responsável pelo atendimento no WhatsApp do estabelecimento "${tenant.tenantName}".
Atue com calor humano, empatia, acolhimento profissional e brevidade real de WhatsApp (parágrafos curtos, de 1 a 3 frases no máximo).

PERSONA & COMUNICAÇÃO:
- Fale SEMPRE em ${
      tenant.personhood === 'FIRST_PERSON_SINGULAR'
        ? '1ª pessoa do singular ("eu atendo", "meu espaço", "minha maca", "posso agendar para você")'
        : '1ª pessoa do plural ("nós atendemos", "nossa equipe", "nosso espaço")'
    }.
- Endereço / Local: ${address}.
- Horários de atendimento: ${hours}.
- Chame o cliente pelo primeiro nome no máximo 1 vez no início. Não repita o nome a cada resposta.
${agendaStatusSummary ? `- Agendamentos/Pacotes atuais do cliente no sistema: ${agendaStatusSummary} (NUNCA diga que não achou no sistema!)` : ''}

CATÁLOGO OFICIAL DE SERVIÇOS E PREÇOS:
${catalogText}

DIRETRIZES DA CONVERSA (ORIENTADA A OBJETIVOS, NÃO A FORMULÁRIOS):
1. Acolha com atenção, entenda a queixa ou interesse do cliente e recomende o procedimento mais adequado com seu valor.
2. ANAMNESE INVISÍVEL: Descubra com sensibilidade o que o cliente sente (região da dor, se há alergia a óleos/cremes e restrições de saúde, cirurgias ou gestação). NUNCA mencione termos como "ficha", "anamnese" ou "questionário".
3. Quando tiver a queixa principal, alergias e restrições de saúde informadas, acione a ferramenta "salvar_anamnese_concluida".
4. Combine o dia e horário preferido. Quando acordado, acione a ferramenta "confirmar_agendamento".
5. SINAL PIX: Solicite o sinal recomendado de 30% para garantir a vaga na maca. Se o cliente pedir flexibilidade (ex: pagar R$ 20 ou R$ 30), aceite com cordialidade para evitar atrito. NUNCA confirme recebimento do Pix por conta própria: diga que você mesma confere o comprovante na conta bancária.

REGRAS ÉTICAS E DE SEGURANÇA:
- Vestimenta obrigatória: homens de bermuda leve; mulheres de calcinha e sutiã. Nudez é terminantemente proibida.
- Recuse imediatamente e com firmeza respeitosa qualquer insinuação sexual ("final feliz", etc.), reforçando que o atendimento é estritamente terapêutico e profissional.
${tenant.skillMarkdown || ''}

CLIENTE ATUAL:
- Nome: ${customer.full_name}
- Telefone: ${customer.phone_number}
- Histórico prévio / Memória: ${customer.shadow_memory || 'Primeiro contato'}
`.trim();
  }

  /**
   * Obtém a lista de serviços do catálogo relacional do tenant
   */
  public getTenantRelationalServices(tenantId: string) {
    try {
      const rows = db
        .prepare(
          `SELECT id, name, description, duration_min, price_single, price_package_4x, recommended_deposit 
           FROM service_catalog WHERE tenant_id = ? AND is_active = 1`
        )
        .all(tenantId) as Array<{
          id: string;
          name: string;
          description?: string | null;
          duration_min: number;
          price_single: number;
          price_package_4x?: number | null;
          recommended_deposit?: number | null;
        }>;

      if (rows && rows.length > 0) return rows;
    } catch {}

    return [
      {
        id: 'srv_relaxante',
        name: 'Massagem Relaxante',
        description: 'Massagem suave e terapêutica para alívio de estresse',
        duration_min: 60,
        price_single: 120.0,
        price_package_4x: 420.0,
        recommended_deposit: 36.0,
      },
      {
        id: 'srv_drenagem',
        name: 'Drenagem Linfática',
        description: 'Redução de retenção de líquidos e inchaço',
        duration_min: 50,
        price_single: 80.0,
        price_package_4x: 280.0,
        recommended_deposit: 24.0,
      },
    ];
  }

  /**
   * Declaração de ferramentas para Function Calling do Gemini
   */
  public getFunctionDeclarations() {
    return [
      {
        functionDeclarations: [
          {
            name: 'salvar_anamnese_concluida',
            description:
              'Registra a conclusão da anamnese invisível quando queixa principal, alergias ou restrições de saúde foram levantadas.',
            parameters: {
              type: 'OBJECT',
              properties: {
                queixa_principal: {
                  type: 'STRING',
                  description: 'Queixa principal relatada pelo cliente ou procedimento acordado.',
                },
                alergias: {
                  type: 'STRING',
                  description: 'Alergias a óleos, cremes ou produtos relatadas (ou "Nenhuma declarada").',
                },
                condicoes_medicas: {
                  type: 'STRING',
                  description: 'Restrições de saúde, cirurgias recentes, dor aguda ou gestação (ou "Nenhuma").',
                },
              },
              required: ['queixa_principal'],
            },
          },
          {
            name: 'confirmar_agendamento',
            description:
              'Registra o agendamento de data e horário acordados com o cliente para a sessão.',
            parameters: {
              type: 'OBJECT',
              properties: {
                servico_nome: {
                  type: 'STRING',
                  description: 'Nome do procedimento ou massagem acordada.',
                },
                data_hora_texto: {
                  type: 'STRING',
                  description: 'Data e horário acordado (ex: "Quarta-feira às 10:30").',
                },
                valor_acordado: {
                  type: 'NUMBER',
                  description: 'Valor acordado para o procedimento ou sessão.',
                },
              },
              required: ['servico_nome', 'data_hora_texto'],
            },
          },
        ],
      },
    ];
  }

  /**
   * Atualiza a contagem de tokens consumidos pelo tenant no mês
   */
  public incrementTenantTokensUsed(tenantId: string, tokens: number): void {
    if (tokens <= 0) return;
    try {
      db.prepare(`UPDATE tenants SET tokens_used_month = COALESCE(tokens_used_month, 0) + ? WHERE id = ?`).run(
        tokens,
        tenantId
      );
    } catch (err) {
      console.error('[ConversationOrchestrator] Erro ao incrementar tokens do tenant:', err);
    }
  }
}

export const conversationOrchestrator = new ConversationOrchestrator();
