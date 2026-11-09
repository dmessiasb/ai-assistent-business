import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDatabase } from './database/db.ts';
import { geminiService } from './hub/ai/gemini.service.ts';
import { whatsappManager } from './hub/whatsapp/baileys.manager.ts';
import { conversationOrchestrator } from './records/conversation.orchestrator.ts';
import { followupWorker } from './records/followup.worker.ts';
import { printGenerator } from './records/print.generator.ts';
import { schemaEngine } from './records/schema.engine.ts';

const __filename = fileURLToPath(import.meta.url);

initDatabase();
conversationOrchestrator.initListeners();

// Auto-reconecta instâncias que já possuem sessão salva em disco (creds.json) ao iniciar o servidor
// Gerenciado exclusivamente por whatsappManager.autoStartSavedSessions() no server.listen()

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Api-Key',
  });
  res.end(JSON.stringify(data));
}

process.on('uncaughtException', (err: any) => {
  console.error('⚠️ [UncaughtException Protegido]:', err?.message || err);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('⚠️ [UnhandledRejection Protegido]:', reason?.message || reason);
});

export const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Api-Key',
      });
      res.end();
      return;
    }

    // 0. Servir Painel Web (Prancheta Digital + Hub Control Panel)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const htmlPath = path.resolve(process.cwd(), 'public/index.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ========================================================================
    // 1. ENDPOINTS DO WHATSAPP & AI CORE HUB
    // ========================================================================
    if (method === 'GET' && pathname === '/api/v1/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'WhatsApp & AI Core Hub + Smart Records Engine (Fases 1 a 5 Ativas)',
        geminiConfigured: geminiService.isConfigured(),
        geminiModel: geminiService.getModelName(),
        memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/config/gemini') {
      const body = await readJsonBody(req);
      const apiKey = String(body.apiKey || '').trim();
      const model = String(body.model || 'gemini-3.8-flash').trim();
      if (!apiKey) {
        sendJson(res, 400, { error: 'Informe uma GEMINI_API_KEY válida.' });
        return;
      }

      geminiService.setCredentials(apiKey, model);

      // Persiste também no arquivo .env para manter após reiniciar
      const envPath = path.resolve(process.cwd(), '.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      if (/^GEMINI_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^GEMINI_API_KEY=.*/m, `GEMINI_API_KEY=${apiKey}`);
      } else {
        envContent += `\nGEMINI_API_KEY=${apiKey}\n`;
      }
      if (/^GEMINI_MODEL=.*/m.test(envContent)) {
        envContent = envContent.replace(/^GEMINI_MODEL=.*/m, `GEMINI_MODEL=${model}`);
      } else {
        envContent += `GEMINI_MODEL=${model}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');

      // Faz um teste rápido na API do Gemini para validar a chave na hora
      const testRes = await geminiService.processInputAndExtractJson({
        text: 'Teste de conexão com Gemini 2.5 Flash: cliente sem alergias.',
      });

      sendJson(res, 200, {
        configured: geminiService.isConfigured(),
        model: geminiService.getModelName(),
        testSuccess: !testRes.usedFallback,
        sampleOutput: testRes,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/instances') {
      const rows = db
        .prepare(
          `SELECT id, name, phone_number, status, qr_code_base64, api_key, created_at, updated_at FROM whatsapp_instances ORDER BY created_at DESC`
        )
        .all();
      sendJson(res, 200, { instances: rows });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/instances') {
      const body = await readJsonBody(req);
      const instanceName = String(body.name || 'Nova Sessão WhatsApp').trim();
      const id =
        body.id?.trim() ||
        `inst_${instanceName
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .slice(0, 20)}_${Date.now().toString().slice(-4)}`;
      const apiKey = `hub_key_${crypto.randomBytes(12).toString('hex')}`;
      const authPath = path.resolve(
        process.cwd(),
        process.env.WHATSAPP_AUTH_DIR || './data/whatsapp_sessions',
        id
      );

      db.prepare(
        `INSERT INTO whatsapp_instances (id, name, status, auth_state_path, api_key) VALUES (?, ?, 'DISCONNECTED', ?, ?)`
      ).run(id, instanceName, authPath, apiKey);

      // Vincula automaticamente à empresa selecionada (ou empresas que estavam sem sessão após exclusão)
      if (body.tenantId) {
        db.prepare(`UPDATE tenants SET whatsapp_instance_id = ? WHERE id = ?`).run(
          id,
          String(body.tenantId)
        );
      } else {
        db.prepare(
          `UPDATE tenants SET whatsapp_instance_id = ? WHERE whatsapp_instance_id IS NULL`
        ).run(id);
      }

      if (body.autoConnect !== false) {
        await whatsappManager.startSession(id).catch((err) =>
          console.error(`[Instances] Erro ao iniciar sessão recém-criada (${id}):`, err)
        );
      }

      const created = db
        .prepare(
          `SELECT id, name, status, qr_code_base64, phone_number, api_key FROM whatsapp_instances WHERE id = ?`
        )
        .get(id);

      sendJson(res, 201, { id, name: instanceName, status: 'STARTING', apiKey, instance: created });
      return;
    }

    const connectMatch = pathname.match(/^\/api\/v1\/instances\/([^/]+)\/connect$/);
    if (method === 'POST' && connectMatch) {
      const instanceId = decodeURIComponent(connectMatch[1]);
      const result = await whatsappManager.startSession(instanceId);
      const updated = db
        .prepare(
          `SELECT id, name, status, qr_code_base64, phone_number FROM whatsapp_instances WHERE id = ?`
        )
        .get(instanceId);
      sendJson(res, 200, { ...result, instance: updated });
      return;
    }

    const resetQrMatch = pathname.match(/^\/api\/v1\/instances\/([^/]+)\/reset-qr$/);
    if (method === 'POST' && resetQrMatch) {
      const instanceId = decodeURIComponent(resetQrMatch[1]);
      await whatsappManager.stopSession(instanceId, true);
      const result = await whatsappManager.startSession(instanceId);
      const updated = db
        .prepare(
          `SELECT id, name, status, qr_code_base64, phone_number FROM whatsapp_instances WHERE id = ?`
        )
        .get(instanceId);
      sendJson(res, 200, { ...result, instance: updated });
      return;
    }

    const disconnectMatch = pathname.match(/^\/api\/v1\/instances\/([^/]+)\/disconnect$/);
    if (method === 'POST' && disconnectMatch) {
      const instanceId = decodeURIComponent(disconnectMatch[1]);
      const body = await readJsonBody(req);
      await whatsappManager.stopSession(instanceId, Boolean(body.logout));
      sendJson(res, 200, { status: 'DISCONNECTED' });
      return;
    }

    const deleteInstanceMatch = pathname.match(/^\/api\/v1\/instances\/([^/]+)$/);
    if (method === 'DELETE' && deleteInstanceMatch) {
      const instanceId = decodeURIComponent(deleteInstanceMatch[1]);
      await whatsappManager.deleteSession(instanceId);
      sendJson(res, 200, { deleted: true, instanceId });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/messages/send') {
      const body = await readJsonBody(req);
      const result = await whatsappManager.sendTextMessage({
        instanceId: body.instanceId || 'inst_principal',
        toPhone: body.toPhone,
        text: body.text,
      });
      sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/messages/simulate-inbound') {
      const body = await readJsonBody(req);
      const instanceId = body.instanceId || 'inst_principal';
      const fromPhone = String(body.fromPhone || '5511988887777');
      const pushName = String(body.pushName || 'Cliente Teste');
      const messageType = body.messageType || 'TEXT';
      const text = String(body.text || '');

      if (body.verticalPresetId) {
        db.prepare(`UPDATE tenants SET vertical_preset_id = ? WHERE whatsapp_instance_id = ?`).run(
          body.verticalPresetId,
          instanceId
        );
      }

      const config = schemaEngine.getTenantConfig(instanceId);
      const aiResult = await geminiService.processInputAndExtractJson({
        text,
        systemInstruction: config
          ? `${config.aiPersona.role}. ${config.aiPersona.extractionInstructions}`
          : 'Extraia os dados estruturados da mensagem.',
        extractionSchemaHint: config?.formSchema,
      });

      const messageId = await whatsappManager.recordAndDispatchInbound({
        instanceId,
        remoteJid: `${fromPhone.replace(/\D/g, '')}@s.whatsapp.net`,
        senderPhone: fromPhone.replace(/\D/g, ''),
        pushName,
        messageType,
        rawText: text,
        aiTranscription: aiResult.transcription,
        aiExtractedData: aiResult.extractedData,
      });

      const lastBotReply = db
        .prepare(
          `SELECT raw_content FROM hub_message_logs WHERE instance_id = ? AND direction = 'OUTBOUND' ORDER BY created_at DESC LIMIT 1`
        )
        .get(instanceId) as { raw_content: string } | undefined;

      sendJson(res, 200, {
        messageId,
        botReply: lastBotReply?.raw_content || null,
        aiResult,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/messages/logs') {
      const logs = db
        .prepare(`SELECT * FROM hub_message_logs ORDER BY created_at DESC LIMIT 30`)
        .all();
      sendJson(res, 200, { logs });
      return;
    }

    // ========================================================================
    // 2. GERENCIAMENTO DE WEBHOOKS (Conectar outras soluções que você criar)
    // ========================================================================
    if (method === 'GET' && pathname === '/api/v1/webhooks') {
      const webhooks = db
        .prepare(`SELECT * FROM webhook_subscriptions ORDER BY created_at DESC`)
        .all();
      sendJson(res, 200, { webhooks });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/webhooks') {
      const body = await readJsonBody(req);
      const id = `wh_${crypto.randomUUID().slice(0, 8)}`;
      const instanceId = body.instanceId || 'inst_principal';
      const targetSystemName = body.targetSystemName;
      const webhookUrl = body.webhookUrl;
      const secretToken = body.secretToken || `sec_${crypto.randomBytes(8).toString('hex')}`;
      const events = body.events || ['message.received', 'audio.transcribed', 'session.status'];
      const routingRules = body.routingRules || {};

      db.prepare(
        `INSERT INTO webhook_subscriptions (
          id, instance_id, target_system_name, webhook_url, secret_token, events, routing_rules
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        instanceId,
        targetSystemName,
        webhookUrl,
        secretToken,
        JSON.stringify(events),
        JSON.stringify(routingRules)
      );

      sendJson(res, 201, {
        id,
        instanceId,
        targetSystemName,
        webhookUrl,
        secretToken,
        events,
        routingRules,
      });
      return;
    }

    const deleteWhMatch = pathname.match(/^\/api\/v1\/webhooks\/([^/]+)$/);
    if (method === 'DELETE' && deleteWhMatch) {
      db.prepare(`DELETE FROM webhook_subscriptions WHERE id = ?`).run(deleteWhMatch[1]);
      sendJson(res, 200, { deleted: true });
      return;
    }

    // ========================================================================
    // 3. FASES 2, 3, 4 e 5: MOTOR MULTI-NICHO, PRANCHETA, PDF QR & FICHA VIVA
    // ========================================================================
    if (method === 'GET' && pathname === '/api/v1/vertical-presets') {
      const rows = db.prepare(`SELECT * FROM vertical_presets WHERE is_active = 1`).all() as Array<{
        id: string;
        name: string;
        description: string;
        terminology: string;
        ai_persona: string;
        form_schema: string;
        alert_rules: string;
        followup_templates: string;
      }>;

      sendJson(res, 200, {
        presets: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          terminology: JSON.parse(r.terminology),
          aiPersona: JSON.parse(r.ai_persona),
          formSchema: JSON.parse(r.form_schema),
          alertRules: JSON.parse(r.alert_rules),
          followupTemplates: JSON.parse(r.followup_templates),
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/tenants') {
      const rows = db
        .prepare(
          `SELECT t.*, vp.name AS preset_name
           FROM tenants t
           JOIN vertical_presets vp ON vp.id = t.vertical_preset_id
           ORDER BY t.created_at ASC`
        )
        .all();
      sendJson(res, 200, { tenants: rows });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/tenants') {
      const body = await readJsonBody(req);
      const id =
        body.id?.trim() ||
        `tenant_${String(body.name || 'empresa')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .slice(0, 18)}_${Date.now().toString().slice(-4)}`;
      const name = String(body.name || 'Nova Empresa');
      const verticalPresetId = String(body.verticalPresetId || 'massoterapia_estetica');
      const ownerPhone = String(body.ownerPhone || '').replace(/\D/g, '');
      const aiApiKey = String(body.aiApiKey || '').trim();
      const aiModel = String(body.aiModel || 'gemini-2.5-flash').trim();
      const securityMode = body.securityMode || 'TEST_WHITELIST';
      const allowedTestJids = JSON.stringify(body.allowedTestJids || []);
      const skillMarkdown = String(
        body.skillMarkdown ||
          `# SKILL DA EMPRESA: ${name}\n## 1. Identidade & Tom de Voz\n- Atendimento natural e humanizado.\n\n## 2. Guardrails de Segurança\n- Nunca inventar preços fora do catálogo.\n- Nunca expor que está preenchendo ficha técnica.`
      );

      // Se não informou instância de WhatsApp, cria uma exclusiva para esta empresa automaticamente!
      let whatsappInstanceId = body.whatsappInstanceId;
      if (!whatsappInstanceId) {
        whatsappInstanceId = `inst_${id.replace(/^tenant_/, '')}`;
        const apiKey = `hub_key_${crypto.randomBytes(12).toString('hex')}`;
        const authPath = path.resolve(
          process.cwd(),
          process.env.WHATSAPP_AUTH_DIR || './data/whatsapp_sessions',
          whatsappInstanceId
        );
        db.prepare(
          `INSERT OR IGNORE INTO whatsapp_instances (id, name, status, auth_state_path, api_key) VALUES (?, ?, 'DISCONNECTED', ?, ?)`
        ).run(whatsappInstanceId, `WhatsApp — ${name}`, authPath, apiKey);
      }

      db.prepare(
        `INSERT INTO tenants (
          id, name, vertical_preset_id, whatsapp_instance_id, owner_phone,
          ai_api_key, ai_model, security_mode, allowed_test_jids, skill_markdown, branding_config
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        name,
        verticalPresetId,
        whatsappInstanceId,
        ownerPhone,
        aiApiKey,
        aiModel,
        securityMode,
        allowedTestJids,
        skillMarkdown,
        JSON.stringify(body.brandingConfig || { primaryColor: '#0D9488', headerText: name })
      );

      sendJson(res, 201, { id, name, whatsappInstanceId, config: schemaEngine.getTenantConfig(id) });
      return;
    }

    const tenantPatchMatch = pathname.match(/^\/api\/v1\/tenants\/([^/]+)$/);
    if (method === 'PATCH' && tenantPatchMatch) {
      const tenantId = tenantPatchMatch[1];
      const body = await readJsonBody(req);
      if (body.verticalPresetId !== undefined) {
        db.prepare(`UPDATE tenants SET vertical_preset_id = ? WHERE id = ?`).run(
          body.verticalPresetId,
          tenantId
        );
      }
      if (body.name !== undefined) {
        db.prepare(`UPDATE tenants SET name = ? WHERE id = ?`).run(body.name, tenantId);
      }
      if (body.ownerPhone !== undefined) {
        db.prepare(`UPDATE tenants SET owner_phone = ? WHERE id = ?`).run(
          String(body.ownerPhone).replace(/\D/g, ''),
          tenantId
        );
      }
      if (body.whatsappInstanceId !== undefined) {
        db.prepare(`UPDATE tenants SET whatsapp_instance_id = ? WHERE id = ?`).run(
          body.whatsappInstanceId,
          tenantId
        );
      }
      if (body.aiApiKey !== undefined) {
        db.prepare(`UPDATE tenants SET ai_api_key = ? WHERE id = ?`).run(
          String(body.aiApiKey).trim(),
          tenantId
        );
      }
      if (body.aiModel !== undefined) {
        db.prepare(`UPDATE tenants SET ai_model = ? WHERE id = ?`).run(
          String(body.aiModel).trim(),
          tenantId
        );
      }
      if (body.securityMode !== undefined) {
        db.prepare(`UPDATE tenants SET security_mode = ? WHERE id = ?`).run(
          body.securityMode,
          tenantId
        );
      }
      if (body.allowedTestJids !== undefined) {
        const jidsArray = Array.isArray(body.allowedTestJids)
          ? body.allowedTestJids
          : String(body.allowedTestJids)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
        db.prepare(`UPDATE tenants SET allowed_test_jids = ? WHERE id = ?`).run(
          JSON.stringify(jidsArray),
          tenantId
        );
      }
      if (body.skillMarkdown !== undefined) {
        db.prepare(`UPDATE tenants SET skill_markdown = ? WHERE id = ?`).run(
          String(body.skillMarkdown),
          tenantId
        );
      }
      if (body.requireDownPayment !== undefined) {
        db.prepare(`UPDATE tenants SET require_down_payment = ? WHERE id = ?`).run(
          body.requireDownPayment ? 1 : 0,
          tenantId
        );
      }
      if (body.pixKey !== undefined) {
        db.prepare(`UPDATE tenants SET pix_key = ? WHERE id = ?`).run(
          String(body.pixKey).trim(),
          tenantId
        );
      }
      if (body.downPaymentInfo !== undefined) {
        db.prepare(`UPDATE tenants SET down_payment_info = ? WHERE id = ?`).run(
          String(body.downPaymentInfo).trim(),
          tenantId
        );
      }
      if (body.agendaConfig !== undefined) {
        db.prepare(`UPDATE tenants SET agenda_config = ? WHERE id = ?`).run(
          typeof body.agendaConfig === 'string'
            ? body.agendaConfig
            : JSON.stringify(body.agendaConfig),
          tenantId
        );
      }
      if (body.whatsappHoursConfig !== undefined) {
        db.prepare(`UPDATE tenants SET whatsapp_hours_config = ? WHERE id = ?`).run(
          typeof body.whatsappHoursConfig === 'string'
            ? body.whatsappHoursConfig
            : JSON.stringify(body.whatsappHoursConfig),
          tenantId
        );
      }
      if (body.servicesCatalog !== undefined && Array.isArray(body.servicesCatalog)) {
        const sanitizedCatalog = body.servicesCatalog
          .filter((s: any) => s && String(s.name || '').trim())
          .map((s: any, idx: number) => ({
            id: String(s.id || `srv_${idx}_${Date.now().toString().slice(-4)}`),
            name: String(s.name).trim(),
            durationMinutes: Math.max(5, Math.round(Number(s.durationMinutes) || 60)),
            priceSingle: Math.max(0, Math.round(Number(s.priceSingle) || 0)),
            pricePackage4:
              s.pricePackage4 !== null && s.pricePackage4 !== undefined && String(s.pricePackage4).trim() !== '' && Number(s.pricePackage4) > 0
                ? Math.round(Number(s.pricePackage4))
                : null,
          }));
        db.prepare(`UPDATE tenants SET services_catalog = ? WHERE id = ?`).run(
          JSON.stringify(sanitizedCatalog),
          tenantId
        );
      }
      const updatedConfig = schemaEngine.getTenantConfig(tenantId);
      if (updatedConfig?.whatsappInstanceId) {
        whatsappManager
          .resumeUnansweredAllowedChats(updatedConfig.whatsappInstanceId)
          .catch((err) => console.error('[TenantUpdate] Erro ao retomar conversas:', err));
      }
      sendJson(res, 200, { updated: true, config: updatedConfig });
      return;
    }

    const confirmPaymentMatch = pathname.match(/^\/api\/v1\/records\/([^/]+)\/confirm-payment$/);
    if (method === 'POST' && confirmPaymentMatch) {
      const recordId = confirmPaymentMatch[1];
      const recRow = db
        .prepare(`SELECT tenant_id FROM dynamic_records WHERE id = ? LIMIT 1`)
        .get(recordId) as { tenant_id: string } | undefined;
      if (!recRow) {
        sendJson(res, 404, { error: 'Ficha não encontrada.' });
        return;
      }
      const config = schemaEngine.getTenantConfig(recRow.tenant_id);
      if (!config) {
        sendJson(res, 404, { error: 'Empresa não encontrada.' });
        return;
      }
      const confirmed = await conversationOrchestrator.confirmPaymentAndSchedule({
        config,
        recordId,
      });
      sendJson(res, 200, confirmed);
      return;
    }

    const printPreviewMatch = pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/print-preview$/);
    if (method === 'GET' && printPreviewMatch) {
      const tenantId = printPreviewMatch[1];
      const qrMode =
        (parsedUrl.searchParams.get('qrMode') as 'STATIC_TENANT' | 'UNIQUE_PER_SHEET') ||
        'STATIC_TENANT';
      const sheet = await printGenerator.generatePrintableBlock({ tenantId, qrMode });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sheet.printableHtml);
      return;
    }

    const queueMatch = pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/queue$/);
    if (method === 'GET' && queueMatch) {
      const tenantId = queueMatch[1];
      const items = db
        .prepare(
          `SELECT q.*, c.full_name AS customer_name
           FROM out_of_hours_queue q
           LEFT JOIN customers c ON c.id = q.customer_id
           WHERE q.tenant_id = ?
           ORDER BY q.created_at DESC LIMIT 50`
        )
        .all(tenantId);
      sendJson(res, 200, { queue: items });
      return;
    }

    const queueProcessMatch = pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/queue\/process$/);
    if (method === 'POST' && queueProcessMatch) {
      const tenantId = queueProcessMatch[1];
      const result = await conversationOrchestrator.processOutOfHoursQueue(tenantId);
      sendJson(res, 200, { success: true, ...result });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/reports/business-summary') {
      const tenantId = parsedUrl.searchParams.get('tenantId') || 'tenant_demo_estetica';
      const report = schemaEngine.getBusinessSummaryReport(tenantId);
      sendJson(res, 200, report);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/records') {
      const tenantFilter = parsedUrl.searchParams.get('tenantId');
      const sql = tenantFilter
        ? `SELECT 
            dr.id,
            dr.tenant_id,
            dr.customer_id,
            dr.status,
            dr.form_data,
            dr.ai_executive_summary,
            dr.consent_signature,
            dr.updated_at,
            c.full_name AS customer_name,
            c.phone_number AS customer_phone,
            c.active_alerts
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           WHERE dr.tenant_id = ?
           ORDER BY dr.updated_at DESC`
        : `SELECT 
            dr.id,
            dr.tenant_id,
            dr.customer_id,
            dr.status,
            dr.form_data,
            dr.ai_executive_summary,
            dr.consent_signature,
            dr.updated_at,
            c.full_name AS customer_name,
            c.phone_number AS customer_phone,
            c.active_alerts
           FROM dynamic_records dr
           JOIN customers c ON c.id = dr.customer_id
           ORDER BY dr.updated_at DESC`;

      const records = (
        tenantFilter ? db.prepare(sql).all(tenantFilter) : db.prepare(sql).all()
      ) as Array<{
        id: string;
        tenant_id: string;
        customer_id: string;
        status: string;
        form_data: string;
        ai_executive_summary: string;
        consent_signature: string;
        updated_at: string;
        customer_name: string;
        customer_phone: string;
        active_alerts: string;
      }>;

      const enriched = records.map((r) => {
        const evolutions = db
          .prepare(
            `SELECT id, source, raw_input, session_date FROM session_evolutions WHERE record_id = ? ORDER BY session_date DESC`
          )
          .all(r.id);

        const audioTranscriptions = db
          .prepare(
            `SELECT id, ai_transcription, created_at FROM hub_message_logs 
             WHERE sender_phone = ? AND message_type = 'AUDIO' AND ai_transcription IS NOT NULL 
             ORDER BY created_at DESC LIMIT 10`
          )
          .all(r.customer_phone);

        return {
          ...r,
          formData: JSON.parse(r.form_data || '{}'),
          activeAlerts: JSON.parse(r.active_alerts || '[]'),
          consentSignature: JSON.parse(r.consent_signature || '{}'),
          evolutions,
          audioTranscriptions,
        };
      });

      sendJson(res, 200, { records: enriched });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/followups') {
      const rows = db
        .prepare(
          `SELECT sf.*, c.full_name AS customer_name, c.phone_number AS customer_phone
           FROM scheduled_followups sf
           JOIN customers c ON c.id = sf.customer_id
           ORDER BY sf.created_at DESC`
        )
        .all();
      sendJson(res, 200, { followups: rows });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/followups/dispatch') {
      const body = await readJsonBody(req);
      const result = await followupWorker.dispatchDueFollowups(Boolean(body.forceAll ?? true));
      sendJson(res, 200, result);
      return;
    }

    const followupReplyMatch = pathname.match(/^\/api\/v1\/followups\/([^/]+)\/reply$/);
    if (method === 'POST' && followupReplyMatch) {
      const body = await readJsonBody(req);
      const result = await followupWorker.processFollowupReply({
        followupId: followupReplyMatch[1],
        customerReply: String(body.replyText || ''),
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: `Rota não encontrada: ${method} ${pathname}` });
  } catch (err: any) {
    console.error('[Server Error]:', err);
    sendJson(res, 500, { error: err?.message || 'Erro interno no servidor' });
  }
});

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const primaryPort = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(
        `ℹ️ Porta ${primaryPort} já está ativa no processo principal. Mantendo apenas o servidor principal conectado ao WhatsApp.`
      );
      // Não inicia servidor duplicado em outra porta para não derrubar a sessão do Baileys (erro 440 connectionReplaced)
      return;
    } else {
      console.error('[Server Error]:', err);
    }
  });

  server.listen(primaryPort, host, () => {
    console.log(
      `🚀 WhatsApp & AI Core Hub + Prancheta Multi-Nicho rodando em http://localhost:${primaryPort} (RAM: ${Math.round(
        process.memoryUsage().rss / 1024 / 1024
      )} MB)`
    );
    whatsappManager.autoStartSavedSessions().catch((err) =>
      console.error('[Startup] Erro ao auto-iniciar sessões WhatsApp:', err)
    );
  });
}
