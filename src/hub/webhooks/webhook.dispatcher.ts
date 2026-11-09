import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { db } from '../../database/db.ts';

export interface HubEventPayload {
  event: 'message.received' | 'audio.transcribed' | 'session.status';
  instanceId: string;
  timestamp: string;
  data: {
    messageId?: string;
    fromPhone?: string;
    remoteJid?: string;
    pushName?: string;
    messageType?: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT';
    rawText?: string;
    aiTranscription?: string;
    aiExtractedData?: Record<string, unknown>;
    sessionStatus?: string;
  };
}

interface WebhookSubscriptionRow {
  id: string;
  instance_id: string;
  target_system_name: string;
  webhook_url: string;
  secret_token: string | null;
  events: string;
  routing_rules: string | null;
  is_active: number;
}

class WebhookDispatcher extends EventEmitter {
  /**
   * Dispara o evento internamente (para módulos locais como a Ficha de Anamnese)
   * e também envia via HTTP POST para todas as outras soluções externas conectadas ao Hub.
   */
  public async dispatch(payload: HubEventPayload): Promise<void> {
    // 1. Notifica listeners internos na mesma aplicação
    this.emit(payload.event, payload);

    // 2. Busca assinaturas de sistemas externos (outras soluções criadas por você)
    const subscriptions = db
      .prepare(
        `SELECT * FROM webhook_subscriptions WHERE instance_id = ? AND is_active = 1`
      )
      .all(payload.instanceId) as unknown as WebhookSubscriptionRow[];

    for (const sub of subscriptions) {
      try {
        const subscribedEvents = JSON.parse(sub.events || '[]') as string[];
        if (!subscribedEvents.includes(payload.event) && !subscribedEvents.includes('*')) {
          continue;
        }

        if (!this.matchesRoutingRules(sub.routing_rules, payload)) {
          continue;
        }

        const bodyString = JSON.stringify(payload);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Hub-Instance': payload.instanceId,
          'X-Hub-Event': payload.event,
        };

        if (sub.secret_token) {
          const signature = crypto
            .createHmac('sha256', sub.secret_token)
            .update(bodyString)
            .digest('hex');
          headers['X-Hub-Signature'] = `sha256=${signature}`;
        }

        fetch(sub.webhook_url, {
          method: 'POST',
          headers,
          body: bodyString,
        }).catch((err) => {
          console.error(
            `[WebhookDispatcher] Falha ao entregar evento para ${sub.target_system_name} (${sub.webhook_url}):`,
            err.message
          );
        });
      } catch (err) {
        console.error(`[WebhookDispatcher] Erro processando subscription ${sub.id}:`, err);
      }
    }
  }

  private matchesRoutingRules(rulesJson: string | null, payload: HubEventPayload): boolean {
    if (!rulesJson) return true;
    try {
      const rules = JSON.parse(rulesJson) as {
        prefix?: string;
        onlyAudio?: boolean;
        senderPhones?: string[];
      };

      const contentText = (
        payload.data.rawText ||
        payload.data.aiTranscription ||
        ''
      ).trim();

      if (rules.prefix && !contentText.toLowerCase().startsWith(rules.prefix.toLowerCase())) {
        return false;
      }

      if (rules.onlyAudio && payload.data.messageType !== 'AUDIO') {
        return false;
      }

      if (
        rules.senderPhones &&
        rules.senderPhones.length > 0 &&
        payload.data.fromPhone &&
        !rules.senderPhones.includes(payload.data.fromPhone)
      ) {
        return false;
      }

      return true;
    } catch {
      return true;
    }
  }
}

export const webhookDispatcher = new WebhookDispatcher();
