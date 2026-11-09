import { db } from '../database/db.ts';
import { whatsappManager } from '../hub/whatsapp/baileys.manager.ts';
import { schemaEngine } from './schema.engine.ts';

export class FollowupWorker {
  /**
   * Dispara os follow-ups pendentes ("Ficha Viva") e retorna o resumo dos envios
   */
  public async dispatchDueFollowups(forceAllPending = false): Promise<{
    dispatchedCount: number;
    items: Array<{ id: string; customerName: string; phone: string; message: string }>;
  }> {
    const query = forceAllPending
      ? `SELECT sf.*, c.full_name, c.phone_number, t.whatsapp_instance_id
         FROM scheduled_followups sf
         JOIN customers c ON c.id = sf.customer_id
         JOIN tenants t ON t.id = sf.tenant_id
         WHERE sf.status = 'PENDING'`
      : `SELECT sf.*, c.full_name, c.phone_number, t.whatsapp_instance_id
         FROM scheduled_followups sf
         JOIN customers c ON c.id = sf.customer_id
         JOIN tenants t ON t.id = sf.tenant_id
         WHERE sf.status = 'PENDING' AND datetime(sf.scheduled_for) <= datetime('now')`;

    const rows = db.prepare(query).all() as Array<{
      id: string;
      tenant_id: string;
      customer_id: string;
      full_name: string;
      phone_number: string;
      whatsapp_instance_id: string;
      message_sent: string;
    }>;

    const dispatchedItems: Array<{
      id: string;
      customerName: string;
      phone: string;
      message: string;
    }> = [];

    for (const row of rows) {
      await whatsappManager.sendTextMessage({
        instanceId: row.whatsapp_instance_id || 'inst_principal',
        toPhone: row.phone_number,
        text: row.message_sent,
      });

      db.prepare(`UPDATE scheduled_followups SET status = 'SENT' WHERE id = ?`).run(row.id);

      dispatchedItems.push({
        id: row.id,
        customerName: row.full_name,
        phone: row.phone_number,
        message: row.message_sent,
      });
    }

    return {
      dispatchedCount: dispatchedItems.length,
      items: dispatchedItems,
    };
  }

  /**
   * Processa a resposta do cliente ao Follow-up Pós-Atendimento ("Ficha Viva"),
   * identificando se houve reação adversa para alertar a profissional imediatamente.
   */
  public async processFollowupReply(params: {
    followupId: string;
    customerReply: string;
  }): Promise<{
    followupId: string;
    sentiment: 'POSITIVE' | 'NEUTRAL' | 'ADVERSE_REACTION';
    status: string;
    professionalAlerted: boolean;
  }> {
    const row = db
      .prepare(
        `SELECT sf.*, c.full_name, c.phone_number
         FROM scheduled_followups sf
         JOIN customers c ON c.id = sf.customer_id
         WHERE sf.id = ?`
      )
      .get(params.followupId) as
      | {
          id: string;
          tenant_id: string;
          customer_id: string;
          record_id: string;
          full_name: string;
          phone_number: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`Followup '${params.followupId}' não encontrado.`);
    }

    const lower = params.customerReply.toLowerCase();
    const isAdverse =
      /dor\s+forte|piorou|incha[cç]o|vermelhid[aã]o|alergia|coceira|mal| tontura|hematoma|ardendo/i.test(
        lower
      );
    const isPositive = /bem|melhor|[oó]tim|excelente|aliviou|maravilhos|100%|zero dor/i.test(lower);

    const sentiment: 'POSITIVE' | 'NEUTRAL' | 'ADVERSE_REACTION' = isAdverse
      ? 'ADVERSE_REACTION'
      : isPositive
      ? 'POSITIVE'
      : 'NEUTRAL';

    const newStatus = isAdverse ? 'ALERT_TRIGGERED' : 'REPLIED';

    db.prepare(
      `UPDATE scheduled_followups
       SET status = ?, customer_reply = ?, ai_sentiment = ?, replied_at = datetime('now')
       WHERE id = ?`
    ).run(newStatus, params.customerReply, sentiment, row.id);

    // Anexa também na linha do tempo da ficha (session_evolutions)
    db.prepare(
      `INSERT INTO session_evolutions (id, record_id, tenant_id, source, raw_input, structured_notes)
       VALUES (?, ?, ?, 'CLIENT_WHATSAPP', ?, ?)`
    ).run(
      `evo_flw_${Date.now().toString().slice(-6)}`,
      row.record_id,
      row.tenant_id,
      `[Retorno Pós-Atendimento]: ${params.customerReply}`,
      JSON.stringify({ sentiment, reply: params.customerReply })
    );

    let professionalAlerted = false;
    const config = schemaEngine.getTenantConfig(row.tenant_id);
    if (isAdverse && config?.ownerPhone) {
      await whatsappManager.sendTextMessage({
        instanceId: config.whatsappInstanceId,
        toPhone: config.ownerPhone,
        text: `🚨 *Alerta de Pós-Atendimento (Ficha Viva)*\n👤 *${config.terminology.clientLabel}:* ${row.full_name} (${row.phone_number})\n💬 *Relato:* "${params.customerReply}"\n⚠️ *Ação recomendada:* Entrar em contato para orientação.`,
      });
      professionalAlerted = true;
    }

    return {
      followupId: row.id,
      sentiment,
      status: newStatus,
      professionalAlerted,
    };
  }
}

export const followupWorker = new FollowupWorker();
