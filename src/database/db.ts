import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_VERTICAL_PRESETS } from './seeds.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFilePath = path.resolve(process.cwd(), process.env.SQLITE_DB_PATH || './data/database.sqlite');
const dbDir = path.dirname(dbFilePath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(dbFilePath);

export function initDatabase(): void {
  // Otimizações para rodar com alta performance e baixo uso de RAM na VM e2-micro do GCP
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const schemaSqlPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf-8');
  db.exec(schemaSql);

  runSafeMigrations();
  seedVerticalPresets();
  seedDefaultInstanceAndTenant();
}

function runSafeMigrations(): void {
  const newColumns = [
    `ALTER TABLE tenants ADD COLUMN ai_api_key TEXT DEFAULT ''`,
    `ALTER TABLE tenants ADD COLUMN ai_model TEXT DEFAULT 'gemini-3.8-flash'`,
    `ALTER TABLE tenants ADD COLUMN security_mode TEXT NOT NULL DEFAULT 'TEST_WHITELIST'`,
    `ALTER TABLE tenants ADD COLUMN allowed_test_jids TEXT NOT NULL DEFAULT '["237327075004656@lid"]'`,
    `ALTER TABLE tenants ADD COLUMN require_down_payment INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tenants ADD COLUMN pix_key TEXT DEFAULT ''`,
    `ALTER TABLE tenants ADD COLUMN down_payment_info TEXT DEFAULT '50% do valor da sessão'`,
    `ALTER TABLE tenants ADD COLUMN services_catalog TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tenants ADD COLUMN skill_markdown TEXT DEFAULT ''`,
    `ALTER TABLE appointments ADD COLUMN package_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN session_number INTEGER`,
    `ALTER TABLE tenants ADD COLUMN agenda_config TEXT DEFAULT '{}'`,
    `ALTER TABLE tenants ADD COLUMN whatsapp_hours_config TEXT DEFAULT '{}'`,
  ];

  for (const sql of newColumns) {
    try {
      db.exec(sql);
    } catch {
      // Coluna já existe
    }
  }

  // Cria tabela de pacotes de clientes se não existir
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_packages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      record_id TEXT,
      service_name TEXT NOT NULL,
      total_sessions INTEGER NOT NULL DEFAULT 4,
      sessions_completed INTEGER NOT NULL DEFAULT 0,
      price REAL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_customer_packages_tenant_customer
      ON customer_packages(tenant_id, customer_id, status);

    CREATE TABLE IF NOT EXISTS out_of_hours_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      customer_id TEXT,
      remote_jid TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      push_name TEXT,
      message_type TEXT NOT NULL DEFAULT 'TEXT',
      raw_content TEXT,
      ai_transcription TEXT,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_out_of_hours_queue_status
      ON out_of_hours_queue(tenant_id, status, created_at ASC);
  `);

  // Migra pacotes pré-existentes de dynamic_records para a tabela estruturada customer_packages
  try {
    const packageRecords = db
      .prepare(
        `SELECT id, tenant_id, customer_id, form_data FROM dynamic_records 
         WHERE form_data LIKE '%Pacote%' AND status IN ('COMPLETED', 'PENDING_PAYMENT')`
      )
      .all() as Array<{ id: string; tenant_id: string; customer_id: string; form_data: string }>;

    for (const prec of packageRecords) {
      const existingPkg = db
        .prepare(`SELECT id FROM customer_packages WHERE customer_id = ? AND record_id = ?`)
        .get(prec.customer_id, prec.id);

      if (!existingPkg) {
        const fd = JSON.parse(prec.form_data || '{}') as Record<string, unknown>;
        const serviceName = String(fd.queixa_principal || 'Pacote 4x Massagem Relaxante');
        const totalSessions = 4;
        const pkgId = `pkg_${prec.customer_id.replace('cust_', '')}_${prec.id.slice(0, 8)}`;

        db.prepare(
          `INSERT OR IGNORE INTO customer_packages (
            id, tenant_id, customer_id, record_id, service_name, total_sessions, sessions_completed, price, status
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 420.00, 'ACTIVE')`
        ).run(pkgId, prec.tenant_id, prec.customer_id, prec.id, serviceName, totalSessions);

        // Vincula agendamentos existentes a este pacote
        db.prepare(
          `UPDATE appointments 
           SET package_id = ?, session_number = 1 
           WHERE customer_id = ? AND (package_id IS NULL OR package_id = '')`
        ).run(pkgId, prec.customer_id);
      }
    }

    // Limpa registros IN_PROGRESS duplicados/órfãos que causavam amnésia
    db.prepare(
      `UPDATE dynamic_records 
       SET status = 'CANCELLED' 
       WHERE id = 'rec_27c27ff0' AND status = 'IN_PROGRESS'`
    ).run();
  } catch (err) {
    console.warn('Aviso na migração de pacotes:', err);
  }
}

function seedVerticalPresets(): void {
  const insertPresetStmt = db.prepare(`
    INSERT OR REPLACE INTO vertical_presets (
      id, name, description, terminology, ai_persona, form_schema, alert_rules, followup_templates
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const preset of INITIAL_VERTICAL_PRESETS) {
    insertPresetStmt.run(
      preset.id,
      preset.name,
      preset.description,
      JSON.stringify(preset.terminology),
      JSON.stringify(preset.ai_persona),
      JSON.stringify(preset.form_schema),
      JSON.stringify(preset.alert_rules),
      JSON.stringify(preset.followup_templates)
    );
  }
}

function seedDefaultInstanceAndTenant(): void {
  const defaultInstanceId = 'inst_principal';
  const existingTenantsCount = (
    db.prepare(`SELECT COUNT(*) as total FROM tenants`).get() as { total: number }
  ).total;
  const authDir = path.resolve(
    process.cwd(),
    process.env.WHATSAPP_AUTH_DIR || './data/whatsapp_sessions',
    defaultInstanceId
  );

  if (existingTenantsCount === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO whatsapp_instances (
        id, name, status, auth_state_path, api_key
      ) VALUES (?, ?, 'DISCONNECTED', ?, ?)
    `).run(defaultInstanceId, 'Conexão Principal WhatsApp Hub', authDir, 'hub_key_default_123');
  }

  const defaultAdenSkill = `# SKILL DA EMPRESA: ADEN Massoterapia
## 1. Identidade, Pessoalidade & Singularidade (Estilo WhatsApp Real)
- **Empresa:** ADEN Massoterapia
- **Nome de Quem Atende:** **Adenilde** (Sempre se apresente e atenda como **Adenilde**! NUNCA use apelidos inventados como "Adenzinha" e NUNCA diga que é "assistente virtual" ou "robô").
- **Profissional Única (Singularidade Obrigatória):** O atendimento é individual, realizado exclusivamente por você. PROIBIDO falar no plural ("nós", "trabalhamos", "temos equipe", "usamos", "nossa clínica"). Fale SEMPRE em 1ª pessoa do singular: "eu atendo", "eu uso", "meu espaço", "minha maca", "eu tenho livre".
- **PROIBIÇÃO ABSOLUTA DE VOCATIVOS ÍNTIMOS/CARINHOSOS:** NUNCA chame o cliente de "meu bem", "amor", "meu amor", "anjo", "meu anjo", "querido", "querida", "lindo", "linda", "flor", "coração". Trate sempre com educação profissional, respeito e acolhimento simpático ("Olá", "Com certeza", "Combinado", "Tudo bem?", "Você prefere...").
- **Naturalidade com o Nome do Cliente:** NÃO repita o nome do cliente em todas as mensagens! Use no máximo 1 vez no início da conversa ou se estritamente necessário. Ficar repetindo o nome soa artificial.
- **REGRA DE BREVIDADE (CRÍTICO):** No WhatsApp as pessoas escrevem pouco! Respostas curtas, diretas e naturais (máximo de 1 a 2 frases curtas, idealmente até 130 caracteres). NUNCA envie mensagens longas.
- **Anamnese Invisível:** NUNCA mencione as palavras "ficha", "anamnese" ou "formulário".

## 2. Agenda Guardada e Controle Rigoroso de Pacotes (Sem Amnésia)
- **Fonte da Verdade Estruturada:** O sistema possui a agenda e o saldo de sessões guardados no banco de dados. NUNCA diga que "não achou no sistema", "não encontrou no histórico" ou "o sistema não destacou".
- **PROIBIDO Inventar Recorrência Automática de Pacotes:** NUNCA diga que "o pacote é semanal e será toda semana no mesmo horário"! Cada sessão de pacote é agendada individualmente conforme a conveniência do cliente.
- **Controle de Saldo:** Se o cliente contratou pacote de 4 sessões e tem 1 agendada, informe com clareza: a sessão marcada e que restam 3 sessões a agendar quando ele quiser.
- **Horário Exato Obrigatório:** Nunca feche agendamento apenas com o dia ("terça") ou turno ("de manhã"). Sempre ofereça os horários livres da agenda (ex: 09:00, 10:30, 11:30) e aguarde o cliente escolher a hora exata antes de pedir o sinal Pix.

## 3. Catálogo Oficial e Preços (Proibido alterar ou inventar descontos)
- **Massagem Relaxante (60 min):** Avulsa R$ 120,00 | Pacote (4 Sessões): R$ 420,00
- **Drenagem Linfática (50 min):** Avulsa R$ 80,00 | Pacote (4 Sessões): R$ 280,00
- **Massagem com Pedras Quentes (75 min):** Avulsa R$ 170,00 | Pacote (4 Sessões): R$ 600,00
- **Thai Massage (60 min):** Avulsa R$ 160,00 | Pacote (4 Sessões): R$ 560,00
- **Massagem Localizada - Foco na Queixa (30 min):** Avulsa R$ 80,00 | Pacote (4 Sessões): R$ 280,00

## 4. Vestimenta e Conduta (Regras Rígidas)
- **Vestimenta Masculina:** Bermuda leve (obrigatório).
- **Vestimenta Feminina:** Calcinha e sutiã (obrigatório).
- **PROIBIDO Nudez:** NUNCA diga que pode ficar nu ou que "fica a critério".
- **Sem Conotação Sexual:** Se houver qualquer insinuação ("final feliz", "massagem completa"), recuse com firmeza e respeito: atendimento estritamente massoterapia terapêutica profissional.

## 5. Tolerância de Valores e Confirmação de Sinal
- **Flexibilidade no Sinal:** Se o cliente negociar um sinal menor (ex: R$ 20 ou R$ 30 em vez de R$ 36), aceite com simpatia para fechar sem atrito.
- **Confirmação Real Obrigatória:** NUNCA confirme por conta própria que o Pix caiu na conta sem a confirmação real da profissional Adenilde. Responda apenas que recebeu e que vai verificar para confirmar logo em seguida.`;

  const envGeminiKey = process.env.GEMINI_API_KEY || '';
  const defaultAdenServices = JSON.stringify([
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
  ]);

  const defaultAdenAgendaConfig = JSON.stringify({
    businessDays: [1, 2, 3, 4, 5, 6], // Seg a Sáb (Domingo fechado)
    openTime: '08:30',
    closeTime: '19:30',
    lunchStart: '12:30',
    lunchEnd: '13:30',
    bufferMinutes: 15, // Intervalo de 15 min respeitado entre atendimentos para higienização e preparo da maca
    slotIntervalMinutes: 30,
    dayOverrides: {
      '6': { openTime: '09:00', closeTime: '14:00', lunchStart: null, lunchEnd: null },
      '0': { closed: true },
    },
  });

  const defaultAdenWhatsappHoursConfig = JSON.stringify({
    enabled: true,
    supportDays: [1, 2, 3, 4, 5, 6], // Seg a Sáb
    openTime: '08:00',
    closeTime: '21:00',
    autoReplyOutOfHours: true,
    outOfHoursMessage:
      'Olá! Meu horário de atendimento no WhatsApp é de segunda a sábado, das 08:00 às 21:00. Recebi sua mensagem e ela já está guardada na minha fila. Assim que eu iniciar o expediente, já te respondo por aqui! 😊',
    dayOverrides: {
      '0': { closed: true },
    },
  });

  db.prepare(`
    INSERT OR IGNORE INTO tenants (
      id, name, vertical_preset_id, whatsapp_instance_id, owner_phone, ai_api_key, ai_model, security_mode, allowed_test_jids, services_catalog, skill_markdown, agenda_config, whatsapp_hours_config, branding_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tenant_demo_estetica',
    'ADEN Massoterapia',
    'massoterapia_estetica',
    defaultInstanceId,
    '5541991769268',
    envGeminiKey,
    'gemini-3.8-flash',
    'TEST_WHITELIST',
    JSON.stringify(['237327075004656@lid', '149091233304709@lid', 'ricardo']),
    defaultAdenServices,
    defaultAdenSkill,
    defaultAdenAgendaConfig,
    defaultAdenWhatsappHoursConfig,
    JSON.stringify({
      primaryColor: '#5F7358',
      headerText: 'ADEN Massoterapia — Ficha de Pré-Atendimento & Bem-Estar',
      footerText: 'Agende seu momento de bem-estar! WhatsApp: (41) 99176-9268',
    })
  );

  // Preserva edições manuais feitas na Skill, lista de contatos e modo de segurança pelo painel
  db.prepare(`
    UPDATE tenants
    SET name = CASE WHEN name IS NULL OR name = '' THEN 'ADEN Massoterapia' ELSE name END,
        ai_model = CASE WHEN ai_model IS NULL OR ai_model = '' THEN 'gemini-3.8-flash' ELSE ai_model END,
        allowed_test_jids = CASE WHEN allowed_test_jids IS NULL OR allowed_test_jids = '' OR allowed_test_jids = '[]' THEN ? ELSE allowed_test_jids END,
        skill_markdown = ?,
        services_catalog = CASE WHEN services_catalog IS NULL OR services_catalog = '' OR services_catalog = '[]' THEN ? ELSE services_catalog END,
        ai_api_key = CASE WHEN ai_api_key IS NULL OR ai_api_key = '' THEN ? ELSE ai_api_key END,
        agenda_config = CASE WHEN agenda_config IS NULL OR agenda_config = '' OR agenda_config = '{}' THEN ? ELSE agenda_config END,
        whatsapp_hours_config = CASE WHEN whatsapp_hours_config IS NULL OR whatsapp_hours_config = '' OR whatsapp_hours_config = '{}' THEN ? ELSE whatsapp_hours_config END
    WHERE id = 'tenant_demo_estetica'
  `).run(
    JSON.stringify(['237327075004656@lid', '149091233304709@lid', 'ricardo']),
    defaultAdenSkill,
    defaultAdenServices,
    envGeminiKey,
    defaultAdenAgendaConfig,
    defaultAdenWhatsappHoursConfig
  );
}
