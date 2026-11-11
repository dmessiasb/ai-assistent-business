import crypto from 'node:crypto';
import { db } from '../database/db.ts';
import { type GeminiCustomerProfile, geminiService } from '../hub/ai/gemini.service.ts';

export interface FormFieldSchema {
  fieldKey: string;
  label: string;
  type: 'text' | 'boolean' | 'boolean_with_details' | 'scale_1_10' | 'select';
  questionPrompt: string;
  required: boolean;
  options?: string[];
}

export interface AlertRuleSchema {
  fieldKey: string;
  condition: 'is_true' | 'not_empty' | 'gte';
  threshold?: number;
  severity: 'CRITICAL' | 'WARNING';
  badgeTemplate: string;
}

export interface FollowupTemplateSchema {
  triggerAfterHours: number;
  messageTemplate: string;
}

export interface TenantServiceItem {
  id: string;
  name: string;
  durationMinutes: number;
  priceSingle: number;
  pricePackage4?: number | null;
}

export interface DownPaymentCalculationResult {
  matchedService: TenantServiceItem | null;
  isPackage: boolean;
  basePrice: number | null;
  downPaymentPercent: number | null;
  downPaymentAmount: number | null;
  formattedServiceLabel: string;
  formattedDownPaymentLine: string;
}

export interface AgendaConfig {
  businessDays: number[]; // [1, 2, 3, 4, 5, 6] (0 = Domingo, 1 = Segunda, ..., 6 = Sábado)
  openTime: string; // Ex: '08:30'
  closeTime: string; // Ex: '19:30'
  lunchStart?: string | null; // Ex: '12:30'
  lunchEnd?: string | null; // Ex: '13:30'
  bufferMinutes: number; // Ex: 15 (minutos de intervalo respeitado entre atendimentos para higienização e preparo da maca)
  slotIntervalMinutes?: number; // Ex: 30
  dayOverrides?: Record<
    string,
    {
      closed?: boolean;
      openTime?: string;
      closeTime?: string;
      lunchStart?: string | null;
      lunchEnd?: string | null;
    }
  >;
}

export interface WhatsAppHoursConfig {
  enabled: boolean;
  supportDays: number[]; // [1, 2, 3, 4, 5, 6]
  openTime: string; // Ex: '08:00'
  closeTime: string; // Ex: '21:00'
  autoReplyOutOfHours: boolean;
  outOfHoursMessage: string;
  dayOverrides?: Record<
    string,
    {
      closed?: boolean;
      openTime?: string;
      closeTime?: string;
    }
  >;
}

export interface HumanHandoffConfig {
  enabled: boolean;
  humanResponseDelaySeconds: number; // Ex: 45s de espera antes do bot responder, dando chance para intervenção humana
  silenceAfterHumanReplyMinutes: number; // Ex: 30 min em silêncio caso o humano tenha falado no chat
  silenceOnPersonalKeywordsHours: number; // Ex: 12 horas em silêncio se detectar "conversa pessoal"
}

export interface EffectiveTenantConfig {
  tenantId: string;
  tenantName: string;
  whatsappInstanceId: string;
  ownerPhone: string;
  aiApiKey: string;
  aiModel: string;
  aiProvider: string;
  monthlyTokenLimit: number;
  tokensUsedMonth: number;
  personhood: 'FIRST_PERSON_SINGULAR' | 'FIRST_PERSON_PLURAL';
  brandingAddress?: string;
  securityMode: 'TEST_WHITELIST' | 'PRODUCTION_ALL';
  allowedTestJids: string[];
  requireDownPayment: boolean;
  pixKey: string;
  downPaymentInfo: string;
  servicesCatalog: TenantServiceItem[];
  skillMarkdown: string;
  agendaConfig: AgendaConfig;
  whatsappHoursConfig: WhatsAppHoursConfig;
  humanHandoffConfig: HumanHandoffConfig;
  presetId: string;
  presetName: string;
  terminology: {
    clientLabel: string;
    professionalLabel: string;
    recordLabel: string;
    sessionLabel: string;
  };
  aiPersona: {
    role: string;
    tone: string;
    extractionInstructions: string;
  };
  formSchema: FormFieldSchema[];
  alertRules: AlertRuleSchema[];
  followupTemplates: FollowupTemplateSchema[];
}

export type ConversationIntent =
  | 'CATALOG_OR_PRICE_QUERY'          // Ex: "Quais os valores?", "Quanto custa a massagem?", "Tem pacote?"
  | 'SERVICE_OR_BOOKING_REQUEST'      // Ex: "Quero agendar uma sessão de massagem relaxante"
  | 'PACKAGE_SESSION_BOOKING_OR_NEW'  // Ex: Cliente com pacote ativo pedindo novo agendamento
  | 'AGENDA_STATUS_INQUIRY'           // Ex: "O que tenho marcado?", "Qual dia?", "Resumo do que tenho", "Já agendou?"
  | 'CLIENT_QUESTION_OR_DOUBT'        // Ex: "Como é o esquema de massagem?", "Completa?", dúvidas em áudio ou pós-ficha
  | 'ANAMNESIS_ANSWER'                // Ex: "Nota 7", "Não tenho alergia", "Dor nas costas"
  | 'CASUAL_CHAT_IGNORE';             // Ex: "Kkkkkkkk", "No vivo?", "Entendi", "Legal", links

export interface CustomerAgendaAndPackageState {
  hasActiveAppointment: boolean;
  hasActivePackage: boolean;
  activeAppointments: Array<{
    id: string;
    recordId?: string;
    packageId?: string;
    sessionNumber?: number;
    serviceName: string;
    appointmentDate: string;
    dayLabel: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    status: string;
  }>;
  activePackages: Array<{
    id: string;
    recordId?: string;
    serviceName: string;
    totalSessions: number;
    sessionsCompleted: number;
    sessionsScheduled: number;
    sessionsRemaining: number;
    price: number;
    status: string;
  }>;
  summaryText: string;
}

export interface FieldExtractionOutcome {
  updatedData: Record<string, unknown>;
  isClientQuestion: boolean;
  conversationalReply: string;
}

const DEFAULT_ADEN_SERVICES: TenantServiceItem[] = [
  {
    id: 'srv_relaxante',
    name: 'Massagem Relaxante',
    durationMinutes: 60,
    priceSingle: 120,
    pricePackage4: 420,
  },
  {
    id: 'srv_drenagem',
    name: 'Drenagem Linfática',
    durationMinutes: 50,
    priceSingle: 80,
    pricePackage4: 280,
  },
  {
    id: 'srv_pedras',
    name: 'Massagem com Pedras Quentes',
    durationMinutes: 75,
    priceSingle: 170,
    pricePackage4: 600,
  },
  {
    id: 'srv_thai',
    name: 'Thai Massage',
    durationMinutes: 60,
    priceSingle: 160,
    pricePackage4: 560,
  },
  {
    id: 'srv_localizada',
    name: 'Massagem Localizada - Foco na Queixa',
    durationMinutes: 30,
    priceSingle: 80,
    pricePackage4: 280,
  },
];

export interface AgendaAvailabilityResult {
  isRequestedTimeFree: boolean;
  conflictingAppointment?: { customerName: string; startTime: string; endTime: string };
  availableSlots: string[];
  isDayClosed?: boolean;
  closedReason?: string;
  reason?: string;
}

export function getBrazilCurrentDateTime(date: Date = new Date()): {
  dow: number;
  time: string;
  dateIso: string;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) partMap[p.type] = p.value;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[partMap.weekday] ?? date.getDay();
  const time = `${partMap.hour}:${partMap.minute}`;
  const dateIso = `${partMap.year}-${partMap.month}-${partMap.day}`;
  return { dow, time, dateIso };
}

export function isWithinWhatsAppSupportHours(
  config: WhatsAppHoursConfig,
  now: Date = new Date()
): { isWithinHours: boolean; currentBrazilTime: string; reason?: string } {
  if (!config || !config.enabled) {
    return { isWithinHours: true, currentBrazilTime: '' };
  }

  const { dow, time } = getBrazilCurrentDateTime(now);
  const dowStr = String(dow);

  const override = config.dayOverrides?.[dowStr];
  if (override?.closed) {
    return {
      isWithinHours: false,
      currentBrazilTime: time,
      reason: 'Dia da semana configurado como fechado para atendimento no WhatsApp',
    };
  }

  const supportDays = Array.isArray(config.supportDays) ? config.supportDays : [1, 2, 3, 4, 5, 6];
  if (!supportDays.includes(dow) && !override?.openTime) {
    return {
      isWithinHours: false,
      currentBrazilTime: time,
      reason: 'Dia da semana fora dos dias de suporte',
    };
  }

  const openTime = override?.openTime || config.openTime || '08:00';
  const closeTime = override?.closeTime || config.closeTime || '21:00';

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const curMin = toMin(time);
  const openMin = toMin(openTime);
  const closeMin = toMin(closeTime);

  if (curMin < openMin || curMin >= closeMin) {
    return {
      isWithinHours: false,
      currentBrazilTime: time,
      reason: `Horário atual (${time}) fora do expediente (${openTime} às ${closeTime})`,
    };
  }

  return {
    isWithinHours: true,
    currentBrazilTime: time,
  };
}

export function isProfessionalActivelyResponding(params: {
  tenantId?: string;
  instanceId?: string;
  senderPhone: string;
  remoteJid: string;
  sinceMinutes?: number;
}): boolean {
  const sinceMin = params.sinceMinutes || 30;
  const cleanPhone = params.senderPhone.replace(/\D/g, '');

  // 0. Verifica se o chat está explicitamente pausado por palavras-chave (ex: "conversa pessoal", "para o bot")
  const recentPause = db
    .prepare(
      `SELECT created_at, raw_content
       FROM hub_message_logs
       WHERE (remote_jid = ? OR sender_phone = ?)
         AND direction = 'INBOUND'
         AND (
           raw_content LIKE '%conversa pessoal%' OR
           raw_content LIKE '%para um pouco o teste%' OR
           raw_content LIKE '%para o bot%' OR
           raw_content LIKE '%pausar bot%' OR
           raw_content LIKE '%conversa particular%' OR
           raw_content LIKE '%chat pessoal%'
         )
         AND created_at >= datetime('now', '-12 hours')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(params.remoteJid, cleanPhone) as { created_at: string; raw_content: string } | undefined;

  if (recentPause) {
    return true;
  }

  // 1. Houve mensagem OUTBOUND manual enviada pela profissional/dono nos últimos sinceMin minutos?
  const recentManual = db
    .prepare(
      `SELECT created_at, raw_content
       FROM hub_message_logs
       WHERE (remote_jid = ? OR sender_phone = ?)
         AND direction = 'OUTBOUND'
         AND (push_name LIKE '%Dono%' OR push_name LIKE '%Você%' OR push_name LIKE '%Profissional%')
         AND created_at >= datetime('now', '-' || ? || ' minutes')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(params.remoteJid, cleanPhone, sinceMin) as { created_at: string; raw_content: string } | undefined;

  if (recentManual) {
    return true;
  }

  // 1.1 Se a profissional respondeu manualmente a qualquer momento nas últimas 3 horas, e a conversa seguiu com mensagens trocadas, estende a proteção
  const recentExtendedManual = db
    .prepare(
      `SELECT created_at, raw_content
       FROM hub_message_logs
       WHERE (remote_jid = ? OR sender_phone = ?)
         AND direction = 'OUTBOUND'
         AND (push_name LIKE '%Dono%' OR push_name LIKE '%Você%' OR push_name LIKE '%Profissional%')
         AND created_at >= datetime('now', '-3 hours')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(params.remoteJid, cleanPhone) as { created_at: string; raw_content: string } | undefined;

  if (recentExtendedManual) {
    // Se a profissional falou nas últimas 3 horas, o bot só pode intervir se o cliente fizer uma pergunta explícita sobre agendamento/procedimento
    const lastInbound = db
      .prepare(
        `SELECT raw_content FROM hub_message_logs
         WHERE (remote_jid = ? OR sender_phone = ?) AND direction = 'INBOUND'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(params.remoteJid, cleanPhone) as { raw_content: string } | undefined;

    const inTxt = (lastInbound?.raw_content || '').toLowerCase();
    const isExplicitBookingOrService =
      /\b(agend|marc|hor[aá]ri|sess[aã]o|massag|procediment|valor|pre[cç]|cat[aá]log|endere[cç]|onde)\b/i.test(
        inTxt
      );

    if (!isExplicitBookingOrService) {
      return true; // Mantém silêncio absoluto para assuntos diversos/pessoais!
    }
  }

  // 2. A última mensagem desse chat foi enviada pela profissional manualmente?
  const lastMsg = db
    .prepare(
      `SELECT direction, push_name, raw_content, created_at
       FROM hub_message_logs
       WHERE (remote_jid = ? OR sender_phone = ?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(params.remoteJid, cleanPhone) as
    | { direction: string; push_name: string | null; raw_content: string; created_at: string }
    | undefined;

  if (
    lastMsg &&
    lastMsg.direction === 'OUTBOUND' &&
    (lastMsg.push_name?.includes('Dono') ||
      lastMsg.push_name?.includes('Você') ||
      lastMsg.push_name?.includes('Profissional'))
  ) {
    return true;
  }

  return false;
}

export class DynamicSchemaEngine {
  public getTenantConfig(tenantIdOrInstanceId: string): EffectiveTenantConfig | null {
    const row = db
      .prepare(
        `
        SELECT 
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.whatsapp_instance_id,
          t.owner_phone,
          t.ai_api_key,
          t.ai_model,
          t.security_mode,
          t.allowed_test_jids,
          t.require_down_payment,
          t.pix_key,
          t.down_payment_info,
          t.services_catalog,
          t.skill_markdown,
          t.agenda_config,
          t.whatsapp_hours_config,
          t.human_handoff_config,
          t.ai_provider,
          t.monthly_token_limit,
          t.tokens_used_month,
          t.personhood,
          t.branding_config,
          t.custom_schema_overrides,
          vp.id AS preset_id,
          vp.name AS preset_name,
          vp.terminology,
          vp.ai_persona,
          vp.form_schema,
          vp.alert_rules,
          vp.followup_templates
        FROM tenants t
        JOIN vertical_presets vp ON vp.id = t.vertical_preset_id
        WHERE t.id = ? OR t.whatsapp_instance_id = ?
        LIMIT 1
      `
      )
      .get(tenantIdOrInstanceId, tenantIdOrInstanceId) as
      | {
          tenant_id: string;
          tenant_name: string;
          whatsapp_instance_id: string;
          owner_phone: string;
          ai_api_key: string | null;
          ai_model: string | null;
          ai_provider: string | null;
          monthly_token_limit: number | null;
          tokens_used_month: number | null;
          personhood: 'FIRST_PERSON_SINGULAR' | 'FIRST_PERSON_PLURAL' | null;
          branding_config: string | null;
          security_mode: 'TEST_WHITELIST' | 'PRODUCTION_ALL' | null;
          allowed_test_jids: string | null;
          require_down_payment: number | null;
          pix_key: string | null;
          down_payment_info: string | null;
          services_catalog: string | null;
          skill_markdown: string | null;
          agenda_config: string | null;
          whatsapp_hours_config: string | null;
          custom_schema_overrides: string;
          preset_id: string;
          preset_name: string;
          terminology: string;
          ai_persona: string;
          form_schema: string;
          alert_rules: string;
          followup_templates: string;
        }
      | undefined;

    if (!row) return null;

    const baseSchema = JSON.parse(row.form_schema || '[]') as FormFieldSchema[];
    const customSchema = JSON.parse(row.custom_schema_overrides || '[]') as FormFieldSchema[];

    // Busca serviços diretamente da tabela relacional service_catalog
    let parsedCatalog: TenantServiceItem[] = [];
    try {
      const dbServices = db
        .prepare(
          `SELECT id, name, duration_min AS durationMinutes, price_single AS priceSingle, price_package_4x AS pricePackage4 
           FROM service_catalog WHERE tenant_id = ? AND is_active = 1`
        )
        .all(row.tenant_id) as Array<{
          id: string;
          name: string;
          durationMinutes: number;
          priceSingle: number;
          pricePackage4: number | null;
        }>;

      if (dbServices.length > 0) {
        parsedCatalog = dbServices;
      } else {
        parsedCatalog = JSON.parse(row.services_catalog || '[]');
      }
    } catch {
      try {
        parsedCatalog = JSON.parse(row.services_catalog || '[]');
      } catch {
        parsedCatalog = [];
      }
    }

    if (!Array.isArray(parsedCatalog) || parsedCatalog.length === 0) {
      parsedCatalog = DEFAULT_ADEN_SERVICES;
    }

    let parsedBrandingAddress = '';
    try {
      if (row.branding_config) {
        const b = JSON.parse(row.branding_config);
        parsedBrandingAddress = b.address || '';
      }
    } catch {}

    let agendaConfig: AgendaConfig = {
      businessDays: [1, 2, 3, 4, 5, 6],
      openTime: '08:30',
      closeTime: '19:30',
      lunchStart: '12:30',
      lunchEnd: '13:30',
      bufferMinutes: 15,
      slotIntervalMinutes: 30,
      dayOverrides: {
        '6': { openTime: '09:00', closeTime: '14:00', lunchStart: null, lunchEnd: null },
        '0': { closed: true },
      },
    };
    try {
      if (row.agenda_config) {
        agendaConfig = { ...agendaConfig, ...JSON.parse(row.agenda_config) };
      }
    } catch {}

    let whatsappHoursConfig: WhatsAppHoursConfig = {
      enabled: true,
      supportDays: [1, 2, 3, 4, 5, 6],
      openTime: '08:00',
      closeTime: '21:00',
      autoReplyOutOfHours: true,
      outOfHoursMessage:
        'Olá! Meu horário de atendimento no WhatsApp é de segunda a sábado, das 08:00 às 21:00. Recebi sua mensagem e ela já está guardada na minha fila. Assim que eu iniciar o expediente, já te respondo por aqui! 😊',
      dayOverrides: {
        '0': { closed: true },
      },
    };
    try {
      if (row.whatsapp_hours_config) {
        whatsappHoursConfig = { ...whatsappHoursConfig, ...JSON.parse(row.whatsapp_hours_config) };
      }
    } catch {}

    let humanHandoffConfig: HumanHandoffConfig = {
      enabled: true,
      humanResponseDelaySeconds: 45,
      silenceAfterHumanReplyMinutes: 30,
      silenceOnPersonalKeywordsHours: 12,
    };
    try {
      if ((row as any).human_handoff_config) {
        humanHandoffConfig = { ...humanHandoffConfig, ...JSON.parse((row as any).human_handoff_config) };
      }
    } catch {}

    return {
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      whatsappInstanceId: row.whatsapp_instance_id,
      ownerPhone: row.owner_phone.replace(/\D/g, ''),
      aiApiKey: (row.ai_api_key || process.env.GEMINI_API_KEY || '').trim(),
      aiModel: (row.ai_model || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
      aiProvider: row.ai_provider || 'gemini',
      monthlyTokenLimit: Number(row.monthly_token_limit) || 500000,
      tokensUsedMonth: Number(row.tokens_used_month) || 0,
      personhood: row.personhood || 'FIRST_PERSON_SINGULAR',
      brandingAddress: parsedBrandingAddress,
      securityMode: row.security_mode || 'TEST_WHITELIST',
      allowedTestJids: JSON.parse(row.allowed_test_jids || '["237327075004656@lid"]'),
      requireDownPayment: Boolean(row.require_down_payment),
      pixKey: (row.pix_key || '').trim(),
      downPaymentInfo: (row.down_payment_info || '50% do valor da sessão').trim(),
      servicesCatalog: parsedCatalog,
      skillMarkdown: row.skill_markdown || '',
      agendaConfig,
      whatsappHoursConfig,
      humanHandoffConfig,
      presetId: row.preset_id,
      presetName: row.preset_name,
      terminology: JSON.parse(row.terminology),
      aiPersona: JSON.parse(row.ai_persona),
      formSchema: [...baseSchema, ...customSchema],
      alertRules: JSON.parse(row.alert_rules || '[]'),
      followupTemplates: JSON.parse(row.followup_templates || '[]'),
    };
  }

  /**
   * Extrai o percentual configurado (ex: "30% do valor da sessão" -> 30)
   * ou valor fixo caso não seja percentual.
   */
  public parseDownPaymentRule(downPaymentInfo: string): {
    percent: number | null;
    fixedValue: number | null;
  } {
    const clean = (downPaymentInfo || '').trim();
    const pctMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (pctMatch) {
      return {
        percent: parseFloat(pctMatch[1].replace(',', '.')),
        fixedValue: null,
      };
    }
    const fixedMatch = clean.match(/(?:r\$\s*)?(\d+(?:[.,]\d+)?)/i);
    if (fixedMatch) {
      return {
        percent: null,
        fixedValue: Math.round(parseFloat(fixedMatch[1].replace(',', '.'))),
      };
    }
    return { percent: 50, fixedValue: null };
  }

  /**
   * Converte o percentual do sinal no valor exato em Reais (sempre arredondado com Math.round)
   * cruzando o procedimento escolhido pelo cliente com o cadastro de serviços da empresa!
   */
  public calculateDownPaymentForService(
    config: EffectiveTenantConfig,
    chosenProcedureText: string
  ): DownPaymentCalculationResult {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const normChoice = normalize(chosenProcedureText || '');
    const rule = this.parseDownPaymentRule(config.downPaymentInfo);

    // Verifica se o cliente escolheu explicitamente Pacote (sem confundir com texto de legenda "| Pacote 4x:")
    const cleanWithoutLegend = normChoice.replace(/\|\s*pacote\s*4x\s*:\s*r\$\s*\d+[.,]?\d*/g, '');
    const isPackage = /\b(pacote|4\s*sessoes|quatro\s*sessoes)\b/i.test(cleanWithoutLegend);

    let matchedService: TenantServiceItem | null = null;
    for (const srv of config.servicesCatalog) {
      const normSrvName = normalize(srv.name);
      const significantWords = normSrvName
        .split(/[\s\-/]+/)
        .filter((w) => w.length >= 4 && !['massagem', 'sessao', 'foco', 'para', 'com'].includes(w));

      if (
        normChoice.includes(normSrvName) ||
        significantWords.some((w) => normChoice.includes(w))
      ) {
        matchedService = srv;
        break;
      }
    }

    // Se o cliente relatou apenas dor/tensão genérica e ainda não citou o nome exato, tenta inferir ou usa o primeiro serviço padrão
    if (!matchedService && normChoice) {
      if (/lombar|cervical|costas|ombro|dor\s+forte|localizada/i.test(normChoice)) {
        matchedService =
          config.servicesCatalog.find((s) => /localizada|relaxante/i.test(s.name)) ||
          config.servicesCatalog[0] ||
          null;
      } else if (/relaxa/i.test(normChoice)) {
        matchedService =
          config.servicesCatalog.find((s) => /relaxante/i.test(s.name)) ||
          config.servicesCatalog[0] ||
          null;
      }
    }

    if (!matchedService) {
      if (rule.fixedValue !== null) {
        return {
          matchedService: null,
          isPackage: false,
          basePrice: null,
          downPaymentPercent: null,
          downPaymentAmount: rule.fixedValue,
          formattedServiceLabel: chosenProcedureText || 'Sessão',
          formattedDownPaymentLine: `*R$ ${rule.fixedValue},00*`,
        };
      }
      return {
        matchedService: null,
        isPackage: false,
        basePrice: null,
        downPaymentPercent: rule.percent,
        downPaymentAmount: null,
        formattedServiceLabel: chosenProcedureText || 'Sessão',
        formattedDownPaymentLine: `*${config.downPaymentInfo}*`,
      };
    }

    const basePrice =
      isPackage && matchedService.pricePackage4
        ? matchedService.pricePackage4
        : matchedService.priceSingle;

    const downPaymentAmount =
      rule.percent !== null
        ? Math.round((basePrice * rule.percent) / 100)
        : rule.fixedValue !== null
          ? Math.round(rule.fixedValue)
          : Math.round(basePrice * 0.5);

    const formattedServiceLabel = isPackage
      ? `Pacote 4x ${matchedService.name} (R$ ${basePrice},00)`
      : `${matchedService.name} (${matchedService.durationMinutes} min — R$ ${basePrice},00)`;

    const formattedDownPaymentLine =
      rule.percent !== null
        ? `*R$ ${downPaymentAmount},00* (referente a ${rule.percent}% de R$ ${basePrice},00 — ${matchedService.name}${isPackage ? ' Pacote 4x' : ''})`
        : `*R$ ${downPaymentAmount},00* (${matchedService.name})`;

    return {
      matchedService,
      isPackage,
      basePrice,
      downPaymentPercent: rule.percent,
      downPaymentAmount,
      formattedServiceLabel,
      formattedDownPaymentLine,
    };
  }

  /**
   * Formata a tabela de serviços cadastrados da empresa para enviar ao cliente ou injetar no prompt da IA.
   */
  public formatServicesCatalogText(
    config: EffectiveTenantConfig,
    includeDownPaymentPreview = false
  ): string {
    const rule = this.parseDownPaymentRule(config.downPaymentInfo);
    return config.servicesCatalog
      .map((srv, idx) => {
        const pkgStr = srv.pricePackage4 ? ` | Pacote (4x): R$ ${srv.pricePackage4},00` : '';
        let signalStr = '';
        if (includeDownPaymentPreview && config.requireDownPayment) {
          const singleSignal =
            rule.percent !== null
              ? Math.round((srv.priceSingle * rule.percent) / 100)
              : rule.fixedValue || 0;
          signalStr = ` ➡️ _Sinal (${rule.percent ? `${rule.percent}%` : 'Fixo'}): R$ ${singleSignal},00_`;
        }
        return `${idx + 1}. *${srv.name}* (${srv.durationMinutes} min): R$ ${srv.priceSingle},00${pkgStr}${signalStr}`;
      })
      .join('\n');
  }

  public isAudioPlaceholderText(text: string): boolean {
    const clean = text.trim().toLowerCase();
    return (
      clean === 'áudio recebido pelo whatsapp' ||
      clean === '[áudio recebido — aguardando transcrição]' ||
      clean === ''
    );
  }

  public isGreetingOnlyText(text: string): boolean {
    const clean = text
      .replace(/[\r\n]+/g, ' ')
      .replace(/[!?.,;😊🙏👋✨]+/g, ' ')
      .trim()
      .toLowerCase();
    return /^(oi+|ol[aá]+|opa+|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|como\s+vai|e\s+a[ií])(\s+(oi+|ol[aá]+|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|como\s+vai))*$/i.test(
      clean
    );
  }

  public hasExplicitHour(text: string): boolean {
    const clean = text.trim().toLowerCase();
    return (
      /\b(?:0?[7-9]|1[0-9]|2[0-2])\s*(?:h\b|h[0-5]\d|:[0-5]\d|horas?)\b/i.test(clean) ||
      /\b[aà]s?\s+(?:0?[7-9]|1[0-9]|2[0-2])(?:\s*e\s*meia)?\b/i.test(clean) ||
      /^(?:0?[7-9]|1[0-9]|2[0-2])(?:\s*e\s*meia)?$/i.test(clean)
    );
  }

  public isValidSchedulePreference(text: string): boolean {
    const clean = text.trim();
    if (!clean || this.isGreetingOnlyText(clean)) return false;
    const norm = clean
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (
      /\b(ofensivo|sabe\s+meu\s+nome|ja\s+avisei|ja\s+falei|como\s+funciona|qual\s+o\s+valor)\b/i.test(
        norm
      )
    ) {
      return false;
    }
    const withoutGreeting = norm
      .replace(/\b(bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi)\b/gi, '')
      .trim();

    const hasDay =
      /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|hoje|amanha|depois\s+de\s+amanha|dia\s+\d{1,2}|\d{1,2}\/\d{1,2})\b/i.test(
        withoutGreeting
      );

    // SÓ considera preferencia_horario completa se tiver TANTO o dia QUANTO o horário exato em horas!
    return hasDay && this.hasExplicitHour(withoutGreeting);
  }

  /**
   * Analisa o que o cliente já informou sobre o agendamento (dia, período manhã/tarde/noite e hora exata),
   * combinando o que estava salvo parcialmente com a nova mensagem.
   */
  public parseScheduleComponents(
    userText: string,
    previousPartial?: { dayLabel?: string; dateIso?: string; period?: string }
  ): {
    dayLabel: string | null;
    dateIso: string | null;
    period: 'MANHA' | 'TARDE' | 'NOITE' | null;
    exactTime: string | null;
  } {
    const norm = userText
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\b(bom\s+dia|boa\s+tarde|boa\s+noite)\b/gi, '')
      .trim();

    let dayLabel: string | null = previousPartial?.dayLabel || null;
    let dateIso: string | null = previousPartial?.dateIso || null;
    let period: 'MANHA' | 'TARDE' | 'NOITE' | null =
      (previousPartial?.period as 'MANHA' | 'TARDE' | 'NOITE') || null;
    let exactTime: string | null = null;

    // Detecta negações explícitas de dias (ex: "só não posso domingo e segunda", "não posso no domingo", "não consigo ir domingo")
    const isNegationContext =
      /\b(?:n[aã]o\s+(?:posso|consigo|d[aá]|vou|quero)|menos|exceto|sem\s+ser)\b/i.test(norm) ||
      /\bs[oó]\s+n[aã]o\b/i.test(norm);

    const now = new Date();
    // Se um partialSchedule anterior tinha "Hoje" mas já passou das 17h, limpa "Hoje" para nunca sugerir "Hoje de manhã" à noite!
    if (dayLabel && /^hoje\b/i.test(dayLabel) && now.getHours() >= 17) {
      dayLabel = null;
      dateIso = null;
    }

    const weekdayMap: Array<{ regex: RegExp; targetDow: number; label: string }> = [
      { regex: /\bdomingo\b/i, targetDow: 0, label: 'Domingo' },
      { regex: /\bsegunda(?:-feira)?\b/i, targetDow: 1, label: 'Segunda-feira' },
      { regex: /\bterca(?:-feira)?\b/i, targetDow: 2, label: 'Terça-feira' },
      { regex: /\bquarta(?:-feira)?\b/i, targetDow: 3, label: 'Quarta-feira' },
      { regex: /\bquinta(?:-feira)?\b/i, targetDow: 4, label: 'Quinta-feira' },
      { regex: /\bsexta(?:-feira)?\b/i, targetDow: 5, label: 'Sexta-feira' },
      { regex: /\bsabado\b/i, targetDow: 6, label: 'Sábado' },
    ];

    // Se o usuário está NEGANDO dias, limpa os dias anteriores se coincidir com o negado e NÃO marca como dia escolhido!
    if (isNegationContext) {
      for (const w of weekdayMap) {
        if (w.regex.test(norm)) {
          if (dayLabel && dayLabel.toLowerCase().includes(w.label.toLowerCase())) {
            dayLabel = null;
            dateIso = null;
            period = null;
          }
        }
      }
    } else if (/\bhoje\b/i.test(norm) && now.getHours() < 17) {
      dateIso = now.toISOString().slice(0, 10);
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      dayLabel = `Hoje (${dd}/${mm})`;
    } else if (/\bamanha\b/i.test(norm)) {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      dateIso = d.toISOString().slice(0, 10);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      dayLabel = `Amanhã (${dd}/${mm})`;
    } else {
      for (const w of weekdayMap) {
        if (w.regex.test(norm)) {
          const d = new Date(now);
          const currentDow = d.getDay();
          let diff = (w.targetDow - currentDow + 7) % 7;
          if (diff === 0 || /proxim[ao]|semana\s+que\s+vem/i.test(norm)) {
            if (diff === 0) diff = 7;
          }
          d.setDate(d.getDate() + diff);
          dateIso = d.toISOString().slice(0, 10);
          const dd = String(d.getDate()).padStart(2, '0');
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          dayLabel = `${w.label} (${dd}/${mm})`;
          break;
        }
      }
    }

    if (/\b(manha|cedo)\b/i.test(norm)) {
      period = 'MANHA';
    } else if (/\btarde\b/i.test(norm)) {
      period = 'TARDE';
    } else if (/\bnoite\b/i.test(norm)) {
      period = 'NOITE';
    }

    // Extrai hora exata (ex: "9h", "09:00", "10h30", "10:30", "às 14", "10 e meia", ou "9")
    const hmMatch =
      norm.match(/\b(0?[7-9]|1[0-9]|2[0-2])\s*(?:h|:)\s*([0-5]\d)\b/i) ||
      norm.match(/\b(0?[7-9]|1[0-9]|2[0-2])\s*e\s*meia\b/i) ||
      norm.match(/\b(0?[7-9]|1[0-9]|2[0-2])\s*(?:h\b|horas?\b)/i) ||
      norm.match(/\bas?\s+(0?[7-9]|1[0-9]|2[0-2])\b/i) ||
      norm.match(/^(0?[7-9]|1[0-9]|2[0-2])$/);

    if (hmMatch) {
      let hr = parseInt(hmMatch[1], 10);
      const min = hmMatch[2]
        ? parseInt(hmMatch[2], 10)
        : /meia/i.test(hmMatch[0])
          ? 30
          : 0;

      // Se a pessoa disse "às 2", "às 3", "às 4", "às 5" na tarde, converte para 14h-17h
      if (hr >= 1 && hr <= 6) {
        hr += 12;
      }
      exactTime = `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      if (!period) {
        period = hr < 12 ? 'MANHA' : hr < 18 ? 'TARDE' : 'NOITE';
      }
    }

    return { dayLabel, dateIso, period, exactTime };
  }

  /**
   * Consulta a agenda guardada (tabela appointments + fichas confirmadas) para um dia específico,
   * verifica se um horário solicitado está livre (considerando a duração do procedimento e buffer entre atendimentos)
   * e retorna os horários disponíveis sem sobrepor outros atendimentos e respeitando os dias/horários da clínica!
   */
  public checkAgendaAvailability(params: {
    tenantId: string;
    dateIso: string;
    dayLabel: string;
    period?: 'MANHA' | 'TARDE' | 'NOITE' | null;
    requestedTime?: string | null;
    durationMinutes?: number;
    excludeRecordId?: string;
  }): AgendaAvailabilityResult {
    const duration = params.durationMinutes || 60;
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    // Obtém configuração da agenda do tenant
    const tenantConfig = this.getTenantConfig(params.tenantId);
    const agendaCfg = tenantConfig?.agendaConfig || {
      businessDays: [1, 2, 3, 4, 5, 6],
      openTime: '08:30',
      closeTime: '19:30',
      lunchStart: '12:30',
      lunchEnd: '13:30',
      bufferMinutes: 15,
      slotIntervalMinutes: 30,
    };

    // Identifica o dia da semana (0 = Domingo, 1 = Segunda, ..., 6 = Sábado)
    let dow = 1;
    if (params.dateIso) {
      const [y, m, d] = params.dateIso.split('-').map(Number);
      if (y && m && d) {
        dow = new Date(y, m - 1, d).getDay();
      }
    } else if (params.dayLabel) {
      const lower = params.dayLabel.toLowerCase();
      if (lower.includes('domingo')) dow = 0;
      else if (lower.includes('segunda')) dow = 1;
      else if (lower.includes('terca')) dow = 2;
      else if (lower.includes('quarta')) dow = 3;
      else if (lower.includes('quinta')) dow = 4;
      else if (lower.includes('sexta')) dow = 5;
      else if (lower.includes('sabado')) dow = 6;
    }

    const dayOverride = agendaCfg.dayOverrides?.[String(dow)];
    const isDayClosed =
      dayOverride?.closed ||
      (!agendaCfg.businessDays.includes(dow) && !dayOverride?.openTime);

    if (isDayClosed) {
      const dayName = dow === 0 ? 'aos domingos' : 'neste dia';
      return {
        isRequestedTimeFree: false,
        isDayClosed: true,
        closedReason: `Não realizo atendimentos ${dayName}. Meu horário de atendimento é de segunda a sábado das ${agendaCfg.openTime} às ${agendaCfg.closeTime}.`,
        availableSlots: [],
      };
    }

    const openTime = dayOverride?.openTime || agendaCfg.openTime || '08:30';
    const closeTime = dayOverride?.closeTime || agendaCfg.closeTime || '19:30';
    const lunchStart =
      dayOverride?.lunchStart !== undefined ? dayOverride.lunchStart : agendaCfg.lunchStart;
    const lunchEnd =
      dayOverride?.lunchEnd !== undefined ? dayOverride.lunchEnd : agendaCfg.lunchEnd;
    const bufferMinutes =
      typeof agendaCfg.bufferMinutes === 'number' ? agendaCfg.bufferMinutes : 15;
    const slotInterval = agendaCfg.slotIntervalMinutes || 30;

    const openMin = toMin(openTime);
    const closeMin = toMin(closeTime);
    const lunchStartMin = lunchStart ? toMin(lunchStart) : null;
    const lunchEndMin = lunchEnd ? toMin(lunchEnd) : null;

    // Busca agendamentos ativos na tabela appointments para esta data ou rótulo de dia
    const cleanDayWord = params.dayLabel.split(' ')[0].toLowerCase();
    const bookedRows = db
      .prepare(
        `SELECT a.start_time, a.end_time, a.record_id, c.full_name
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         WHERE a.tenant_id = ?
           AND a.status IN ('PENDING_PAYMENT', 'CONFIRMED')
           AND (a.appointment_date = ? OR lower(a.day_label) LIKE ?)`
      )
      .all(params.tenantId, params.dateIso, `%${cleanDayWord}%`) as Array<{
      start_time: string;
      end_time: string;
      record_id: string | null;
      full_name: string;
    }>;

    // Também verifica dynamic_records legados
    const legacyRecords = db
      .prepare(
        `SELECT dr.id, dr.form_data, c.full_name
         FROM dynamic_records dr
         JOIN customers c ON c.id = dr.customer_id
         WHERE dr.tenant_id = ? AND dr.status IN ('PENDING_PAYMENT', 'COMPLETED')`
      )
      .all(params.tenantId) as Array<{ id: string; form_data: string; full_name: string }>;

    const occupiedIntervals: Array<{
      startMin: number;
      endMin: number;
      startTime: string;
      endTime: string;
      customerName: string;
    }> = [];

    for (const b of bookedRows) {
      if (params.excludeRecordId && b.record_id === params.excludeRecordId) continue;
      occupiedIntervals.push({
        startMin: toMin(b.start_time),
        endMin: toMin(b.end_time),
        startTime: b.start_time,
        endTime: b.end_time,
        customerName: b.full_name,
      });
    }

    for (const r of legacyRecords) {
      if (params.excludeRecordId && r.id === params.excludeRecordId) continue;
      if (bookedRows.some((b) => b.record_id === r.id)) continue;
      const fd = JSON.parse(r.form_data || '{}') as Record<string, unknown>;
      const pref = String(fd.preferencia_horario || '');
      if (pref && pref.toLowerCase().includes(cleanDayWord)) {
        const parsed = this.parseScheduleComponents(pref);
        if (parsed.exactTime) {
          const st = toMin(parsed.exactTime);
          const et = st + 60;
          const eh = String(Math.floor(et / 60)).padStart(2, '0');
          const em = String(et % 60).padStart(2, '0');
          occupiedIntervals.push({
            startMin: st,
            endMin: et,
            startTime: parsed.exactTime,
            endTime: `${eh}:${em}`,
            customerName: r.full_name,
          });
        }
      }
    }

    // Regra rígida de intervalo/buffer entre atendimentos ("respeitando um atendimento a outro"):
    // Dois atendimentos conflitam se o intervalo [cStart, cEnd + buffer] colide com [eStart, eEnd + buffer]!
    const overlaps = (cStart: number, dur: number) => {
      const cEnd = cStart + dur;
      return occupiedIntervals.find(
        (occ) => cStart < occ.endMin + bufferMinutes && cEnd + bufferMinutes > occ.startMin
      );
    };

    const overlapsLunch = (cStart: number, dur: number) => {
      if (lunchStartMin === null || lunchEndMin === null) return false;
      const cEnd = cStart + dur;
      return cStart < lunchEndMin && cEnd > lunchStartMin;
    };

    // Gera slots candidatos dentro do horário de abertura até o fechamento com passo de slotInterval
    const candidateSlots: string[] = [];
    for (let t = openMin; t + duration <= closeMin; t += slotInterval) {
      if (overlapsLunch(t, duration)) continue;
      if (overlaps(t, duration)) continue;

      const hh = String(Math.floor(t / 60)).padStart(2, '0');
      const mm = String(t % 60).padStart(2, '0');
      candidateSlots.push(`${hh}:${mm}`);
    }

    // Filtra pelo turno solicitado (MANHA, TARDE, NOITE)
    let filteredSlots = candidateSlots;
    if (params.period === 'MANHA') {
      filteredSlots = candidateSlots.filter((s) => toMin(s) < 720);
    } else if (params.period === 'TARDE') {
      filteredSlots = candidateSlots.filter((s) => toMin(s) >= 720 && toMin(s) < 1080);
    } else if (params.period === 'NOITE') {
      filteredSlots = candidateSlots.filter((s) => toMin(s) >= 1080);
    }

    // Seleciona até 4 opções bem distribuídas para não poluir a mensagem
    const availableSlots: string[] = [];
    if (filteredSlots.length <= 4) {
      availableSlots.push(...filteredSlots);
    } else {
      const step = Math.floor(filteredSlots.length / 3);
      availableSlots.push(
        filteredSlots[0],
        filteredSlots[step],
        filteredSlots[Math.min(filteredSlots.length - 1, step * 2)]
      );
      if (filteredSlots.length > 3 && !availableSlots.includes(filteredSlots[filteredSlots.length - 1])) {
        availableSlots.push(filteredSlots[filteredSlots.length - 1]);
      }
    }

    if (params.requestedTime) {
      const reqMin = toMin(params.requestedTime);
      if (reqMin < openMin || reqMin + duration > closeMin) {
        return {
          isRequestedTimeFree: false,
          reason: `O horário das ${params.requestedTime} está fora do meu expediente (${openTime} às ${closeTime})!`,
          availableSlots,
        };
      }

      if (overlapsLunch(reqMin, duration)) {
        return {
          isRequestedTimeFree: false,
          reason: `O horário das ${params.requestedTime} coincide com o meu intervalo de almoço (${lunchStart} às ${lunchEnd})!`,
          availableSlots,
        };
      }

      const conflict = overlaps(reqMin, duration);
      if (conflict) {
        return {
          isRequestedTimeFree: false,
          conflictingAppointment: {
            customerName: conflict.customerName,
            startTime: conflict.startTime,
            endTime: conflict.endTime,
          },
          reason: `Às ${params.requestedTime} a maca já está ocupada ou em preparo/higienização com outro atendimento!`,
          availableSlots,
        };
      }
    }

    return {
      isRequestedTimeFree: true,
      availableSlots,
    };
  }

  /**
   * Salva ou atualiza o compromisso na tabela de agenda (appointments) para bloquear o horário.
   */
  public saveAppointmentSlot(params: {
    tenantId: string;
    customerId: string;
    recordId: string;
    serviceName: string;
    dateIso: string;
    dayLabel: string;
    startTime: string;
    durationMinutes: number;
    status: 'PENDING_PAYMENT' | 'CONFIRMED';
    packageId?: string;
    sessionNumber?: number;
  }): void {
    const [h, m] = params.startTime.split(':').map(Number);
    const totalEnd = (h || 0) * 60 + (m || 0) + (params.durationMinutes || 60);
    const endTime = `${String(Math.floor(totalEnd / 60)).padStart(2, '0')}:${String(totalEnd % 60).padStart(2, '0')}`;

    const existing = db
      .prepare(`SELECT id FROM appointments WHERE record_id = ? LIMIT 1`)
      .get(params.recordId) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE appointments
         SET service_name = ?, appointment_date = ?, day_label = ?, start_time = ?, end_time = ?, duration_minutes = ?, status = ?, package_id = COALESCE(?, package_id), session_number = COALESCE(?, session_number), updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        params.serviceName,
        params.dateIso,
        params.dayLabel,
        params.startTime,
        endTime,
        params.durationMinutes,
        params.status,
        params.packageId || null,
        params.sessionNumber || null,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO appointments (
          id, tenant_id, customer_id, record_id, package_id, session_number, service_name, appointment_date, day_label, start_time, end_time, duration_minutes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `apt_${crypto.randomUUID().slice(0, 8)}`,
        params.tenantId,
        params.customerId,
        params.recordId,
        params.packageId || null,
        params.sessionNumber || null,
        params.serviceName,
        params.dateIso,
        params.dayLabel,
        params.startTime,
        endTime,
        params.durationMinutes,
        params.status
      );
    }
  }

  /**
   * Consulta o estado estruturado da agenda e pacotes do cliente guardados no banco de dados.
   * Elimina qualquer amnésia ou alucinação da IA.
   */
  public getCustomerAgendaAndPackages(
    tenantId: string,
    customerId: string
  ): CustomerAgendaAndPackageState {
    const appointmentsRaw = db
      .prepare(
        `SELECT id, record_id, package_id, session_number, service_name, appointment_date, day_label, start_time, end_time, duration_minutes, status
         FROM appointments
         WHERE tenant_id = ? AND customer_id = ? AND status IN ('CONFIRMED', 'PENDING_PAYMENT')
         ORDER BY appointment_date ASC, start_time ASC`
      )
      .all(tenantId, customerId) as Array<{
        id: string;
        record_id?: string;
        package_id?: string;
        session_number?: number;
        service_name: string;
        appointment_date: string;
        day_label: string;
        start_time: string;
        end_time: string;
        duration_minutes: number;
        status: string;
      }>;

    const packagesRaw = db
      .prepare(
        `SELECT id, record_id, service_name, total_sessions, sessions_completed, price, status, created_at
         FROM customer_packages
         WHERE tenant_id = ? AND customer_id = ? AND status = 'ACTIVE'
         ORDER BY created_at DESC`
      )
      .all(tenantId, customerId) as Array<{
        id: string;
        record_id?: string;
        service_name: string;
        total_sessions: number;
        sessions_completed: number;
        price: number;
        status: string;
        created_at: string;
      }>;

    const activeAppointments = appointmentsRaw.map((a) => ({
      id: a.id,
      recordId: a.record_id,
      packageId: a.package_id,
      sessionNumber: a.session_number,
      serviceName: a.service_name,
      appointmentDate: a.appointment_date,
      dayLabel: a.day_label,
      startTime: a.start_time,
      endTime: a.end_time,
      durationMinutes: a.duration_minutes,
      status: a.status,
    }));

    const activePackages = packagesRaw.map((pkg) => {
      const scheduledCount = activeAppointments.filter(
        (a) =>
          a.packageId === pkg.id ||
          (!a.packageId && a.serviceName.toLowerCase().includes('relaxante'))
      ).length;
      const completedCount = pkg.sessions_completed || 0;
      const remainingCount = Math.max(0, pkg.total_sessions - completedCount - scheduledCount);

      return {
        id: pkg.id,
        recordId: pkg.record_id,
        serviceName: pkg.service_name,
        totalSessions: pkg.total_sessions,
        sessionsCompleted: completedCount,
        sessionsScheduled: scheduledCount,
        sessionsRemaining: remainingCount,
        price: pkg.price || 420.0,
        status: pkg.status,
      };
    });

    const parts: string[] = [];
    if (activeAppointments.length > 0) {
      const firstApt = activeAppointments[0];
      const sessionPrefix = firstApt.sessionNumber
        ? `a ${firstApt.sessionNumber}ª sessão d`
        : '';
      parts.push(
        `Seu agendamento está confirmado para *${firstApt.dayLabel} às ${firstApt.startTime}* (${sessionPrefix ? sessionPrefix + 'o ' : ''}${firstApt.serviceName}).`
      );
    }

    if (activePackages.length > 0) {
      const pkg = activePackages[0];
      parts.push(
        `Você possui o *${pkg.serviceName}* (Total: ${pkg.totalSessions} sessões | ${pkg.sessionsScheduled} agendada(s) | ${pkg.sessionsCompleted} realizada(s) | *${pkg.sessionsRemaining} restante(s)* a agendar).`
      );
      parts.push(
        `As próximas sessões do pacote não são automáticas: a gente combina cada uma conforme a sua preferência quando você desejar marcar!`
      );
    }

    const summaryText =
      parts.length > 0
        ? parts.join(' ')
        : 'No momento você não possui nenhum horário pré-agendado no sistema.';

    return {
      hasActiveAppointment: activeAppointments.length > 0,
      hasActivePackage: activePackages.length > 0,
      activeAppointments,
      activePackages,
      summaryText,
    };
  }

  /**
   * Gera o relatório consolidado de desempenho do negócio (serviços executados, agendados e pacotes).
   */
  public getBusinessSummaryReport(tenantId: string): {
    metrics: {
      totalCustomers: number;
      totalExecutions: number;
      upcomingAppointmentsCount: number;
      activePackagesCount: number;
      totalContractedSessions: number;
      executedSessions: number;
      remainingPackageSessions: number;
      totalContractedRevenue: number;
      estimatedReceivedRevenue: number;
      balanceToReceive: number;
    };
    upcomingAppointments: Array<{
      customerName: string;
      customerPhone: string;
      dayLabel: string;
      startTime: string;
      serviceName: string;
      status: string;
    }>;
    recentExecutions: Array<{
      customerName: string;
      sessionDate: string;
      notes: string;
    }>;
    activePackages: Array<{
      customerName: string;
      packageName: string;
      totalSessions: number;
      sessionsCompleted: number;
      sessionsRemaining: number;
    }>;
    popularServices: Array<{ serviceName: string; count: number }>;
    formattedReportText: string;
  } {
    const totalCustomers = (
      db.prepare(`SELECT COUNT(*) as total FROM customers WHERE tenant_id = ?`).get(tenantId) as {
        total: number;
      }
    ).total;

    const executionsRaw = db
      .prepare(
        `SELECT se.id, se.session_date, se.raw_input, c.full_name
         FROM session_evolutions se
         JOIN dynamic_records dr ON dr.id = se.record_id
         JOIN customers c ON c.id = dr.customer_id
         WHERE se.tenant_id = ?
         ORDER BY se.session_date DESC LIMIT 10`
      )
      .all(tenantId) as Array<{ session_date: string; raw_input: string; full_name: string }>;

    const upcomingAppointmentsRaw = db
      .prepare(
        `SELECT a.id, a.day_label, a.start_time, a.service_name, a.status, c.full_name, c.phone_number
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         WHERE a.tenant_id = ? AND a.status IN ('CONFIRMED', 'PENDING_PAYMENT')
         ORDER BY a.appointment_date ASC, a.start_time ASC`
      )
      .all(tenantId) as Array<{
        day_label: string;
        start_time: string;
        service_name: string;
        status: string;
        full_name: string;
        phone_number: string;
      }>;

    const packagesRaw = db
      .prepare(
        `SELECT p.id, p.service_name, p.total_sessions, p.sessions_completed, p.price, p.status, c.full_name
         FROM customer_packages p
         JOIN customers c ON c.id = p.customer_id
         WHERE p.tenant_id = ? AND p.status = 'ACTIVE'`
      )
      .all(tenantId) as Array<{
        service_name: string;
        total_sessions: number;
        sessions_completed: number;
        price: number;
        full_name: string;
      }>;

    let totalContractedSessions = 0;
    let executedSessions = executionsRaw.length;
    let remainingPackageSessions = 0;
    let totalContractedRevenue = 0;

    const activePackagesList = packagesRaw.map((p) => {
      totalContractedSessions += p.total_sessions;
      const rem = Math.max(0, p.total_sessions - p.sessions_completed);
      remainingPackageSessions += rem;
      totalContractedRevenue += p.price || 420.0;
      return {
        customerName: p.full_name,
        packageName: p.service_name,
        totalSessions: p.total_sessions,
        sessionsCompleted: p.sessions_completed,
        sessionsRemaining: rem,
      };
    });

    // Soma faturamento de sessões avulsas finalizadas
    const singleRecords = db
      .prepare(
        `SELECT form_data FROM dynamic_records 
         WHERE tenant_id = ? AND status = 'COMPLETED' AND form_data NOT LIKE '%Pacote%'`
      )
      .all(tenantId) as Array<{ form_data: string }>;

    for (const sr of singleRecords) {
      totalContractedRevenue += 120.0; // Valor médio avulso
    }

    const estimatedReceivedRevenue = Math.round(totalContractedRevenue * 0.45); // Sinais e sessões quitadas
    const balanceToReceive = Math.max(0, totalContractedRevenue - estimatedReceivedRevenue);

    // Contagem de serviços mais procurados
    const serviceCounts = new Map<string, number>();
    for (const a of upcomingAppointmentsRaw) {
      const cleanName = a.service_name.replace(/\s*\([^)]*\)/g, '').trim();
      serviceCounts.set(cleanName, (serviceCounts.get(cleanName) || 0) + 1);
    }
    for (const p of packagesRaw) {
      const cleanName = p.service_name.replace(/\s*\([^)]*\)/g, '').trim();
      serviceCounts.set(cleanName, (serviceCounts.get(cleanName) || 0) + 1);
    }
    const popularServices = Array.from(serviceCounts.entries())
      .map(([serviceName, count]) => ({ serviceName, count }))
      .sort((a, b) => b.count - a.count);

    // Monta o relatório em formato visual Markdown para WhatsApp ou Painel
    const reportLines: string[] = [
      `📊 *RELATÓRIO DO NEGÓCIO — ADEN Massoterapia*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👥 *Clientes Cadastrados:* ${totalCustomers}`,
      `💆‍♀️ *Sessões Executadas:* ${executedSessions}`,
      `📅 *Agendamentos Futuros:* ${upcomingAppointmentsRaw.length}`,
      `📦 *Pacotes Ativos:* ${packagesRaw.length} (${remainingPackageSessions} sessões a realizar)`,
      ``,
      `💰 *Financeiro:*`,
      `• Total Contratado: R$ ${totalContractedRevenue.toFixed(2).replace('.', ',')}`,
      `• Estimado Recebido (Sinais/Sessões): R$ ${estimatedReceivedRevenue.toFixed(2).replace('.', ',')}`,
      `• Saldo a Receber: R$ ${balanceToReceive.toFixed(2).replace('.', ',')}`,
      ``,
      `🏆 *Procedimentos Mais Procurados:*`,
    ];

    if (popularServices.length > 0) {
      popularServices.forEach((s, idx) => {
        reportLines.push(`${idx + 1}. ${s.serviceName}: ${s.count} atendimento(s)`);
      });
    } else {
      reportLines.push(`• Nenhum procedimento registrado ainda.`);
    }

    if (upcomingAppointmentsRaw.length > 0) {
      reportLines.push(``, `🗓️ *Próximos Agendamentos Confirmados:*`);
      upcomingAppointmentsRaw.slice(0, 5).forEach((a) => {
        reportLines.push(`• *${a.full_name}:* ${a.day_label} às ${a.start_time} (${a.service_name})`);
      });
    }

    return {
      metrics: {
        totalCustomers,
        totalExecutions: executedSessions,
        upcomingAppointmentsCount: upcomingAppointmentsRaw.length,
        activePackagesCount: packagesRaw.length,
        totalContractedSessions,
        executedSessions,
        remainingPackageSessions,
        totalContractedRevenue,
        estimatedReceivedRevenue,
        balanceToReceive,
      },
      upcomingAppointments: upcomingAppointmentsRaw.map((a) => ({
        customerName: a.full_name,
        customerPhone: a.phone_number,
        dayLabel: a.day_label,
        startTime: a.start_time,
        serviceName: a.service_name,
        status: a.status,
      })),
      recentExecutions: executionsRaw.map((e) => ({
        customerName: e.full_name,
        sessionDate: e.session_date,
        notes: e.raw_input,
      })),
      activePackages: activePackagesList,
      popularServices,
      formattedReportText: reportLines.join('\n'),
    };
  }

  /**
   * Analisa o contexto da mensagem recebida e do histórico recente da conversa
   * para decidir se o assistente deve interagir ou ficar em silêncio (conversa pessoal).
   */
  public classifyConversationIntent(params: {
    userText: string;
    messageType?: string;
    hasActiveInProgressRecord: boolean;
    hasCompletedRecord?: boolean;
    hasActivePackageWithRemainingSessions?: boolean;
    currentStepFieldKey?: string;
    recentMessages?: Array<{ direction: string; content: string }>;
  }): ConversationIntent {
    const text = params.userText.trim();
    const lower = text.toLowerCase();

    // 0. Se o áudio falhou na transcrição por algum motivo de rede, nunca preenche a ficha com placeholder
    if (this.isAudioPlaceholderText(text)) {
      return 'CLIENT_QUESTION_OR_DOUBT';
    }

    // 1. Links soltos, risadas, reações, comentários casuais ou conversa pessoal/doméstica -> Ficar em silêncio!
    if (
      /^https?:\/\//i.test(text) ||
      /^(k{3,}|haha+|rs+|lol|😂|🤣|❤️|👍|🙏|🫠)+$/i.test(lower) ||
      /^(entendi|legal|show|top|beleza|blz|ta bom|tá bom|ok|aham|no vivo\s*\??|verdade|pois [eé]|caramba|nossa|valeu|obrigad[oa]|de nada|combinado|fechou)$/i.test(
        lower
      ) ||
      /\b(term[oô]metro|aqu[aá]rio|temperatura\s+d[ao]\s+[aá]gua|pl[aá]stico|pacotes?|sal[aã]o|saindo|chegando|em\s+casa|paranagu[aá]|trabalho|mercado|a[cç]ougue|almo[cç]o|janta|casa|minutos?\s+estou)\b/i.test(
        lower
      )
    ) {
      return 'CASUAL_CHAT_IGNORE';
    }

    // 1.2. Saudações ("Olá", "Boa noite !") iniciam ou retomam o atendimento com simpatia
    if (this.isGreetingOnlyText(text)) {
      return params.hasActiveInProgressRecord ? 'ANAMNESIS_ANSWER' : 'SERVICE_OR_BOOKING_REQUEST';
    }

    // 1.3. Consulta ou conferência sobre agendamentos guardados ou pacotes no sistema (SEM AMNÉSIA)
    if (
      /\b(o\s+que\s+(?:eu\s+)?tenho\s+(?:marcado|agendado)|resumo\s+do\s+que\s+tenho|quais\s+(?:os\s+)?(?:meus\s+)?hor[aá]rios|qual\s+(?:ou\s+quais\s+)?quartas|qual\s+dia|quando\s+[eé]\s+meu\s+atendimento|quando\s+ficou|j[aá]\s+tinha\s+o\s+dia|est[aá]\s+na\s+conversa|marquei\s+a\s+mensagem|j[aá]\s+agendou|conseguiu\??|n[aã]o\s+tinha\s+agendado|certeza\??|o\s+meu\s+que\s+eu\s+estava\s+perguntando|minha\s+agenda|meus\s+agendamentos|resumo\s+dos?\s+hor[aá]rios?)\b/i.test(
        lower
      )
    ) {
      return 'AGENDA_STATUS_INQUIRY';
    }

    // 1.5. Dúvida direta sobre valores, preços, pacotes ou catálogo de procedimentos da ADEN Massoterapia
    if (
      /\b(qual\s+o\s+valor|quais\s+os\s+valores|quanto\s+custa|pre[cç]o|tabela|cat[aá]logo|quais\s+massagens|quais\s+procedimentos|quais\s+servi[cç]os|tem\s+pacote)\b/i.test(
        lower
      )
    ) {
      return 'CATALOG_OR_PRICE_QUERY';
    }

    // 2. Dúvidas abertas, reclamações/observações ("você nem sabe meu nome", "já avisei", "achei ofensivo"), endereço, esquema ou perguntas com "?"
    if (
      /\b(como\s+funciona|como\s+[eé]\s+o\s+esquema|esquema\s+d[ae]\s+massagem|completa\s*\??|onde\s+fica|endere[cç]o|onde\s+[eé]\s+a\s+massagem|localiza[cç][aã]o|aceita\s+cart[aã]o|aceita\s+pix|formas?\s+de\s+pagamento|hor[aá]rio\s+de\s+atendimento|d[uú]vida|sabe\s+meu\s+nome|j[aá]\s+avisei|j[aá]\s+falei|j[aá]\s+respondi|ofensivo|de\s+cara)\b/i.test(
        lower
      )
    ) {
      return 'CLIENT_QUESTION_OR_DOUBT';
    }

    // 3. Pedido de agendamento: se o cliente já possui um pacote ativo com sessões restantes, prioriza o fluxo inteligente de pacote!
    if (
      /\b(quero\s+agendar|gostaria\s+de\s+agendar|agendar\s+uma?\s+sess[aã]o|marcar\s+uma?\s+sess[aã]o|marcar\s+uma?\s+massagem|massagem|relaxante|drenagem|pedras\s+quentes|thai|localizada|procedimento|preencher\s+ficha|anamnese|#ficha|#teste)\b/i.test(
        lower
      )
    ) {
      if (params.hasActivePackageWithRemainingSessions) {
        return 'PACKAGE_SESSION_BOOKING_OR_NEW';
      }
      return 'SERVICE_OR_BOOKING_REQUEST';
    }

    // 4. Relato espontâneo de sintomas/queixas/alergias
    if (
      /\b(estou\s+com\s+dor|muita\s+dor|dor\s+n[ao]|tens[aã]o|al[eé]rgi[ca]|gestante|gr[aá]vida|press[aã]o\s+alta)\b/i.test(
        lower
      )
    ) {
      return 'ANAMNESIS_ANSWER';
    }

    // 5. Se já existe uma entrevista de anamnese ativa (IN_PROGRESS), qualquer resposta normal ou áudio continua o atendimento!
    if (params.hasActiveInProgressRecord && params.currentStepFieldKey) {
      // Se for conversa pessoal evidente no meio, não preenche nem força pergunta!
      if (
        /\b(term[oô]metro|aqu[aá]rio|temperatura|pl[aá]stico|pacotes?|sal[aã]o|saindo|chegando|em\s+casa|paranagu[aá]|a[cç]ougue|almo[cç]o)\b/i.test(
          lower
        )
      ) {
        return 'CASUAL_CHAT_IGNORE';
      }
      return 'ANAMNESIS_ANSWER';
    }

    // 6. Se o cliente já tem ficha concluída (COMPLETED) ou enviou um ÁUDIO no atendimento:
    // IMPORTANTE: Só responde se a mensagem parecer minimamente direcionada a atendimento ou dúvida!
    // Se for conversa pessoal, recado do dia a dia ou assunto aleatório, IGNORA!
    if (params.hasCompletedRecord || params.messageType === 'AUDIO') {
      const looksLikeBusinessOrQuestion =
        text.includes('?') ||
        params.messageType === 'AUDIO' ||
        /\b(agend|marc|hor[aá]ri|sess[aã]o|massag|procediment|valor|pre[cç]|cat[aá]log|endere[cç]|onde|d[uú]vid|dor|atend)\b/i.test(
          lower
        );

      if (looksLikeBusinessOrQuestion) {
        return 'CLIENT_QUESTION_OR_DOUBT';
      }

      // Caso contrário, é mensagem pessoal/avulsa (ex: "estou saindo", "obrigado por me trazer", etc.) -> Silêncio!
      return 'CASUAL_CHAT_IGNORE';
    }

    return 'CASUAL_CHAT_IGNORE';
  }

  public async extractFieldsFromInput(params: {
    config: EffectiveTenantConfig;
    userText: string;
    currentStepFieldKey?: string;
    existingData: Record<string, unknown>;
    recentHistory?: string;
    customerProfile?: GeminiCustomerProfile;
    precomputedAiData?: Record<string, unknown>;
    precomputedIsQuestion?: boolean;
    precomputedReply?: string;
  }): Promise<FieldExtractionOutcome> {
    const {
      config,
      userText,
      currentStepFieldKey,
      existingData,
      recentHistory,
      customerProfile,
    } = params;
    const updatedData: Record<string, unknown> = { ...existingData };
    let isClientQuestion = Boolean(params.precomputedIsQuestion);
    let conversationalReply = params.precomputedReply || '';
    let aiSucceeded = false;

    // Nunca preenche campos de ficha com texto placeholder de falha de áudio
    if (this.isAudioPlaceholderText(userText)) {
      return {
        updatedData,
        isClientQuestion: true,
        conversationalReply:
          'Perdão, o áudio ficou um pouquinho baixo aqui pra mim 😅 Você poderia me mandar por texto ou gravar novamente, por favor?',
      };
    }

    // 1. PRÉ-EXTRAÇÃO DE 1ª PESSOA E CONTEXTO (Antes de chamar o Gemini):
    // Se o cliente falou em 1ª pessoa que está com dor ("eu tô com uma dor nas pernas que tá me incomodando"),
    // JÁ preenche automaticamente para_quem_e_nivel_dor para que o assistente NUNCA faça a pergunta óbvia "é pra você mesma?"!
    const lowerInput = userText.toLowerCase();
    if (
      /\b(eu\s+t[oô]|t[oô]\s+com|estou\s+com|minha\s+lombar|minhas?\s+pernas?|minhas?\s+costas|meu\s+ombro|meu\s+pesco[cç]o|me\s+incomodando|doendo\s+bastante|sinto\s+dor|dor\s+n[ao]s?\s+(?:pernas?|costas|lombar|cervical|ombro|corpo)|pra\s+mim|para\s+mim)\b/i.test(
        lowerInput
      ) &&
      !/\b(marido|esposa|m[aã]e|pai|filh|namorad|outra\s+pessoa)\b/i.test(lowerInput)
    ) {
      updatedData.para_quem_e_nivel_dor = `Para si mesma(o) — ${userText.trim()}`;
    }

    // Se o cliente disse "quero uma dessa", "quero essa", "vou querer essa", olha qual massagem acabou de ser explicada no histórico!
    if (/\b(quero\s+uma?\s+dessa|quero\s+essa|vou\s+querer\s+essa|pode\s+ser\s+essa|fechar\s+essa)\b/i.test(lowerInput) && recentHistory) {
      const lastLines = recentHistory.split('\n').slice(-3).join(' ');
      const fromContext = this.calculateDownPaymentForService(config, lastLines);
      if (fromContext.matchedService) {
        updatedData.queixa_principal = fromContext.formattedServiceLabel;
      }
    }

    const currentFieldObj = config.formSchema.find((f) => f.fieldKey === currentStepFieldKey);
    const missingFieldsHint = config.formSchema
      .filter(
        (f) =>
          f.required &&
          (updatedData[f.fieldKey] === undefined ||
            updatedData[f.fieldKey] === null ||
            updatedData[f.fieldKey] === '')
      )
      .map((f) => ({
        fieldKey: f.fieldKey,
        label: f.label,
        questionPrompt: f.questionPrompt,
      }));

    const dynamicCatalogBlock =
      `\n\n## CATÁLOGO ATUALIZADO DE SERVIÇOS E VALORES DA EMPRESA (${config.tenantName}):\n` +
      this.formatServicesCatalogText(config, true);

    if (params.precomputedAiData && Object.keys(params.precomputedAiData).length > 0) {
      for (const [k, v] of Object.entries(params.precomputedAiData)) {
        if (v !== null && v !== undefined && v !== '' && k !== 'raw_text') {
          if (k === 'preferencia_horario' && !this.isValidSchedulePreference(String(v))) {
            continue;
          }
          updatedData[k] = v;
        }
      }
    } else if (config.aiApiKey || geminiService.isConfigured()) {
      try {
        const schemaDescription = config.formSchema.map((f) => ({
          fieldKey: f.fieldKey,
          label: f.label,
          type: f.type,
        }));

        const recentHistoryArray: Array<{ role: 'user' | 'model'; text: string }> = [];
        if (recentHistory) {
          const lines = recentHistory.split('\n');
          for (const l of lines) {
            if (l.startsWith('Cliente:')) {
              recentHistoryArray.push({ role: 'user', text: l.replace(/^Cliente:\s*/, '') });
            } else if (l.startsWith('Atendente:')) {
              recentHistoryArray.push({ role: 'model', text: l.replace(/^Atendente:\s*/, '') });
            }
          }
        }

        const dynamicSystemInstruction = `Você é assistente virtual de ${config.tenantName}.
${config.aiPersona.role}. ${config.aiPersona.extractionInstructions}
${config.skillMarkdown}
${dynamicCatalogBlock}
Identidade e tom de voz: Atue com cordialidade profissional e brevidade.
Fale em ${config.personhood === 'FIRST_PERSON_SINGULAR' ? '1ª pessoa do singular ("eu atendo", "meu espaço", "posso agendar")' : '1ª pessoa do plural ("nós atendemos")'}.
Dados já respondidos: ${JSON.stringify(existingData || {})}
Campos pendentes: ${JSON.stringify(missingFieldsHint || [])}
Retorne na resposta conversacional uma mensagem acolhedora, humana e objetiva.`;

        const aiResult = await geminiService.processInputAndExtractJson({
          text: userText,
          systemInstruction: dynamicSystemInstruction,
          recentHistory: recentHistoryArray,
          apiKeyOverride: config.aiApiKey,
          modelOverride: config.aiModel,
        });

        conversationalReply = aiResult.conversationalReply || '';
        aiSucceeded = Boolean(conversationalReply);

        // Se houve chamada de função para salvar anamnese
        if (aiResult.functionCalls && aiResult.functionCalls.length > 0) {
          for (const fc of aiResult.functionCalls) {
            if (fc.name === 'salvar_anamnese_concluida') {
              if (fc.args.queixa_principal) updatedData.queixa_principal = fc.args.queixa_principal;
              if (fc.args.alergias) updatedData.alergias_restricoes = fc.args.alergias;
              if (fc.args.condicoes_medicas) updatedData.condicoes_especiais = fc.args.condicoes_medicas;
            }
          }
        }
      } catch (err) {
        console.error('[SchemaEngine] Erro no Gemini, aplicando heurística local:', err);
      }
    }

    // Só aplica extrator heurístico local se a mensagem não for uma pergunta/reclamação/saudação e se o Gemini não tiver processado
    const looksLikeQuestion =
      isClientQuestion ||
      /\?$/.test(userText.trim()) ||
      /\b(como\s+funciona|como\s+[eé]\s+o\s+esquema|completa\s*\??|onde\s+fica|endere[cç]o|qual\s+o\s+valor|quanto\s+custa|sabe\s+meu\s+nome|ofensivo|de\s+cara)\b/i.test(
        userText
      );

    if (!looksLikeQuestion && !this.isGreetingOnlyText(userText) && !aiSucceeded) {
      const localExtracted = this.runSmartPortugueseExtractor(
        userText,
        config.formSchema,
        currentStepFieldKey,
        config.servicesCatalog
      );

      for (const [k, v] of Object.entries(localExtracted)) {
        if (updatedData[k] === undefined || updatedData[k] === null) {
          updatedData[k] = v;
        }
      }
    }

    // Se por acaso o cliente escolheu um serviço do catálogo em queixa_principal, padroniza com o nome e valor oficial do catálogo!
    if (updatedData.queixa_principal) {
      const calc = this.calculateDownPaymentForService(
        config,
        String(updatedData.queixa_principal)
      );
      if (calc.matchedService) {
        updatedData.queixa_principal = calc.formattedServiceLabel;
      }
    }

    return {
      updatedData,
      isClientQuestion: looksLikeQuestion,
      conversationalReply,
    };
  }

  public evaluateAlerts(
    config: EffectiveTenantConfig,
    formData: Record<string, unknown>
  ): string[] {
    const alerts: string[] = [];

    for (const rule of config.alertRules) {
      const rawVal = formData[rule.fieldKey];
      if (rawVal === undefined || rawVal === null) continue;

      if (rule.condition === 'is_true') {
        const isTrue =
          rawVal === true ||
          (typeof rawVal === 'object' &&
            rawVal !== null &&
            (rawVal as { value?: boolean }).value === true);

        if (isTrue) {
          const details =
            typeof rawVal === 'object' && rawVal !== null
              ? (rawVal as { details?: string }).details || 'Sim'
              : 'Sim';
          alerts.push(
            rule.badgeTemplate
              .replace('{{details}}', details)
              .replace('{{value}}', String(details))
          );
        }
      } else if (rule.condition === 'gte' && rule.threshold !== undefined) {
        const numVal = Number(rawVal);
        if (!Number.isNaN(numVal) && numVal >= rule.threshold) {
          alerts.push(rule.badgeTemplate.replace('{{value}}', String(numVal)));
        }
      } else if (rule.condition === 'not_empty') {
        if (String(rawVal).trim().length > 0) {
          alerts.push(rule.badgeTemplate.replace('{{value}}', String(rawVal)));
        }
      }
    }

    return alerts;
  }

  public buildExecutiveSummary(
    config: EffectiveTenantConfig,
    customerName: string,
    formData: Record<string, unknown>,
    alerts: string[]
  ): string {
    const lines: string[] = [];
    lines.push(`📋 *${config.terminology.recordLabel} — ${customerName}*`);

    if (alerts.length > 0) {
      lines.push(`⚡ *Alertas:* ${alerts.join(' | ')}`);
    } else {
      lines.push(`✅ *Alertas:* Nenhum alerta crítico relatado`);
    }

    for (const field of config.formSchema) {
      const val = formData[field.fieldKey];
      if (val === undefined || val === null) continue;

      let formatted = '';
      if (typeof val === 'object' && val !== null && 'value' in val) {
        const boolObj = val as { value: boolean; details?: string };
        formatted = boolObj.value
          ? `Sim (${boolObj.details || 'Sem detalhes'})`
          : 'Não';
      } else if (typeof val === 'boolean') {
        formatted = val ? 'Sim' : 'Não';
      } else {
        formatted = String(val);
      }

      lines.push(`• *${field.label}:* ${formatted}`);
    }

    return lines.join('\n');
  }

  public getNextMissingField(
    config: EffectiveTenantConfig,
    formData: Record<string, unknown>
  ): FormFieldSchema | null {
    for (const field of config.formSchema) {
      if (!field.required) continue;
      const val = formData[field.fieldKey];
      if (val === undefined || val === null || val === '') {
        return field;
      }
    }
    return null;
  }

  private runSmartPortugueseExtractor(
    text: string,
    schema: FormFieldSchema[],
    currentStepFieldKey?: string,
    servicesCatalog: TenantServiceItem[] = DEFAULT_ADEN_SERVICES
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lower = text.toLowerCase().trim();

    if (
      this.isAudioPlaceholderText(text) ||
      this.isGreetingOnlyText(text) ||
      /^(#ficha|quero preencher)$/i.test(lower)
    ) {
      return result;
    }

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const normText = normalize(text);

    for (const field of schema) {
      if (field.type === 'scale_1_10') {
        const matchScale =
          lower.match(/(?:n[ií]vel|nota|dor|grau)\s*(?:de\s*)?(\d{1,2})/i) ||
          (currentStepFieldKey === field.fieldKey ? lower.match(/\b(10|[0-9])\b/) : null);

        if (matchScale) {
          result[field.fieldKey] = Math.min(10, Math.max(0, Number(matchScale[1])));
        } else if (currentStepFieldKey === field.fieldKey) {
          if (/sem\s+dor|nenhuma|zero|relaxar|relaxamento|focar|n[aã]o\s+sinto|nada/i.test(lower)) {
            result[field.fieldKey] = 0;
          } else if (/pouca|leve|baixa|pouquinho/i.test(lower)) {
            result[field.fieldKey] = 3;
          } else if (/m[eé]dia|moderada|mais ou menos|um pouco/i.test(lower)) {
            result[field.fieldKey] = 5;
          } else if (/muita|forte|alta|intensa|bastante|demais/i.test(lower)) {
            result[field.fieldKey] = 8;
          }
        }
      }

      if (field.fieldKey === 'alergias' || field.fieldKey === 'alergia_dermatologica') {
        if (/n[aã]o\s+tenho\s+alergia|sem\s+alergia/i.test(lower)) {
          result[field.fieldKey] = { value: false, details: '' };
        } else {
          const alergiaMatch = lower.match(/al[eé]rgi(?:a|co|ca)\s+(?:a\s+)?([^.,;]+)/i);
          if (alergiaMatch) {
            result[field.fieldKey] = { value: true, details: alergiaMatch[1].trim() };
          }
        }
      }

      if (field.fieldKey === 'gestante') {
        if (/n[aã]o\s+(?:estou|sou)\s+gestante|n[aã]o\s+estou\s+gr[aá]vida/i.test(lower)) {
          result[field.fieldKey] = { value: false, details: '' };
        } else if (/\b(gestante|gr[aá]vida)\b/i.test(lower)) {
          result[field.fieldKey] = { value: true, details: text.trim() };
        }
      }

      if (field.fieldKey === 'historico_saude') {
        if (/press[aã]o\s+alta|hipertens|diabet|cirurgia|trombose|gestante|gr[aá]vida/i.test(lower)) {
          if (/n[aã]o\s+tenho|n[aã]o\s+estou|sem\s+problemas|nenhuma/i.test(lower)) {
            result[field.fieldKey] = { value: false, details: '' };
          } else {
            result[field.fieldKey] = { value: true, details: text.trim() };
            if (/\b(gestante|gr[aá]vida)\b/i.test(lower)) {
              result['gestante'] = { value: true, details: text.trim() };
            }
          }
        }
      }

      if (field.fieldKey === 'para_quem_e_nivel_dor') {
        const matchScale = lower.match(/(?:n[ií]vel|nota|dor|grau)\s*(?:de\s*)?(\d{1,2})/i);
        if (matchScale) {
          result['nivel_dor'] = Math.min(10, Math.max(0, Number(matchScale[1])));
          result[field.fieldKey] = text.trim();
        } else if (
          /pra\s+mim|para\s+mim|pro\s+meu|para\s+o|para\s+a|marido|esposa|m[aã]e|pai|filh|namorad/i.test(
            lower
          ) ||
          (currentStepFieldKey === field.fieldKey &&
            /\b(dor|tens[aã]o|relaxar|leve|forte|moderada|nenhuma|zero|\d{1,2})\b/i.test(lower))
        ) {
          result[field.fieldKey] = text.trim();
        }
      }

      if (field.fieldKey === 'queixa_principal') {
        // Verifica primeiro se bate com algum serviço cadastrado no catálogo da empresa
        let matchedSrv: TenantServiceItem | null = null;
        for (const srv of servicesCatalog) {
          const normSrv = normalize(srv.name);
          const keywords = normSrv
            .split(/[\s\-/]+/)
            .filter((w) => w.length >= 4 && !['massagem', 'sessao', 'foco', 'para', 'com'].includes(w));
          if (normText.includes(normSrv) || keywords.some((w) => normText.includes(w))) {
            matchedSrv = srv;
            break;
          }
        }

        if (matchedSrv && !/como\s+[eé]\s+o\s+esquema|como\s+funciona/i.test(lower)) {
          const isPkg = /\b(pacote|4\s*sess[oõ]es|4x)\b/i.test(lower);
          const price =
            isPkg && matchedSrv.pricePackage4 ? matchedSrv.pricePackage4 : matchedSrv.priceSingle;
          result[field.fieldKey] = isPkg
            ? `Pacote 4x ${matchedSrv.name} (R$ ${price},00)`
            : `${matchedSrv.name} (${matchedSrv.durationMinutes} min — R$ ${price},00)`;
        } else if (
          /dor\s+|tens[aã]o|relaxar|estresse|lombar|cervical|costas|ombro/i.test(lower) &&
          !/como\s+[eé]\s+o\s+esquema|como\s+funciona/i.test(lower)
        ) {
          result[field.fieldKey] = text.trim();
        }
      }

      if (field.fieldKey === 'preferencia_horario') {
        if (this.isValidSchedulePreference(text)) {
          result[field.fieldKey] = text.trim();
        }
      }
    }

    if (currentStepFieldKey && result[currentStepFieldKey] === undefined) {
      const targetField = schema.find((f) => f.fieldKey === currentStepFieldKey);
      if (targetField) {
        if (targetField.type === 'boolean' || targetField.type === 'boolean_with_details') {
          const isNo = /\b(n[aã]o|nenhum|nenhuma|nada|nunca|zero|normal|tudo\s+bem|tranquilo)\b/i.test(lower);
          const isYes = /\b(sim|tenho|estou|uso|possuo)\b/i.test(lower);
          if (isNo) {
            result[currentStepFieldKey] =
              targetField.type === 'boolean_with_details'
                ? { value: false, details: '' }
                : false;
          } else if (isYes) {
            const cleanDetails = text.replace(/^(sim\s*[,.-]?\s*)/i, '').trim();
            result[currentStepFieldKey] =
              targetField.type === 'boolean_with_details'
                ? { value: true, details: cleanDetails || 'Confirmado pelo cliente' }
                : true;
          }
        } else if (
          targetField.type !== 'scale_1_10' &&
          currentStepFieldKey !== 'preferencia_horario' &&
          currentStepFieldKey !== 'queixa_principal'
        ) {
          result[currentStepFieldKey] = text.trim();
        }
      }
    }

    return result;
  }
}

export const schemaEngine = new DynamicSchemaEngine();
