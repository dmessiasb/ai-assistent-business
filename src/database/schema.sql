-- ============================================================================
-- DOMÍNIO 1: WHATSAPP & AI CORE HUB (Independente e Reutilizável)
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number TEXT,
    status TEXT NOT NULL DEFAULT 'DISCONNECTED', -- DISCONNECTED | QR_READY | CONNECTED
    qr_code_base64 TEXT,
    auth_state_path TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    target_system_name TEXT NOT NULL, -- Ex: 'anamnese-saas', 'bot-agendamento', 'erp'
    webhook_url TEXT NOT NULL,
    secret_token TEXT,
    events TEXT NOT NULL DEFAULT '["message.received","audio.transcribed","session.status"]', -- JSON Array
    routing_rules TEXT DEFAULT '{}', -- JSON: {"prefix": "#ficha", "onlyAudio": false}
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hub_message_logs (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    remote_jid TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    push_name TEXT,
    direction TEXT NOT NULL, -- INBOUND | OUTBOUND
    message_type TEXT NOT NULL, -- TEXT | AUDIO | IMAGE | DOCUMENT
    raw_content TEXT,
    ai_transcription TEXT,
    ai_extracted_json TEXT, -- JSON extraído pelo Gemini
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hub_messages_instance_phone
    ON hub_message_logs(instance_id, sender_phone, created_at DESC);

-- ============================================================================
-- DOMÍNIO 2: FICHAS INTELIGENTES MULTI-NICHO (Config-Driven)
-- ============================================================================

CREATE TABLE IF NOT EXISTS vertical_presets (
    id TEXT PRIMARY KEY, -- Ex: 'massoterapia_estetica', 'pet_shop', 'oficina_vistoria'
    name TEXT NOT NULL,
    description TEXT,
    terminology TEXT NOT NULL, -- JSON: clientLabel, professionalLabel, recordLabel, sessionLabel
    ai_persona TEXT NOT NULL, -- JSON: role, tone, extractionInstructions
    form_schema TEXT NOT NULL, -- JSON Array de campos dinâmicos e regras de pergunta
    alert_rules TEXT NOT NULL DEFAULT '[]', -- JSON Array de regras de alerta crítico
    followup_templates TEXT NOT NULL DEFAULT '[]', -- JSON Array de gatilhos pós-atendimento (D+1, D+15)
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vertical_preset_id TEXT NOT NULL,
    whatsapp_instance_id TEXT,
    owner_phone TEXT NOT NULL, -- Telefone da profissional (habilita Modo Ditado por Voz)
    ai_api_key TEXT DEFAULT '', -- Chave de IA (Gemini) exclusiva desta empresa
    ai_model TEXT DEFAULT 'gemini-2.5-flash',
    security_mode TEXT NOT NULL DEFAULT 'TEST_WHITELIST', -- TEST_WHITELIST | PRODUCTION_ALL
    allowed_test_jids TEXT NOT NULL DEFAULT '["237327075004656@lid"]', -- Contatos liberados quando em modo teste
    require_down_payment INTEGER NOT NULL DEFAULT 0, -- 1 = Exige sinal via Pix para agendar | 0 = Não exige sinal
    pix_key TEXT DEFAULT '', -- Chave Pix da empresa (CPF, CNPJ, Celular, E-mail ou Aleatória)
    down_payment_info TEXT DEFAULT '50% do valor da sessão', -- Valor ou regra do sinal (ex: R$ 50,00 ou 30% do valor da sessão)
    services_catalog TEXT NOT NULL DEFAULT '[]', -- JSON Array de serviços/procedimentos com valores para cálculo automático do sinal arredondado
    skill_markdown TEXT DEFAULT '', -- Skill e Guardrails de Segurança exclusivos da empresa
    agenda_config TEXT DEFAULT '{}', -- JSON: dias de atendimento, horários de abertura/fechamento, almoço e buffer entre atendimentos
    whatsapp_hours_config TEXT DEFAULT '{}', -- JSON: horário de atendimento do WhatsApp e fila noturna
    human_handoff_config TEXT DEFAULT '{}', -- JSON: atraso de resposta do bot, silêncio após resposta humana e pausa por conversa pessoal
    ai_provider TEXT DEFAULT 'gemini', -- Provedor de IA: gemini | openai | anthropic
    monthly_token_limit INTEGER DEFAULT 500000, -- Limite mensal de tokens do tenant
    tokens_used_month INTEGER DEFAULT 0, -- Tokens consumidos no mês vigente
    personhood TEXT DEFAULT 'FIRST_PERSON_SINGULAR', -- FIRST_PERSON_SINGULAR | FIRST_PERSON_PLURAL
    custom_schema_overrides TEXT DEFAULT '[]', -- JSON com perguntas extras específicas da clínica
    branding_config TEXT DEFAULT '{}', -- JSON: logoUrl, primaryColor, headerText, footerText, address
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (vertical_preset_id) REFERENCES vertical_presets(id),
    FOREIGN KEY (whatsapp_instance_id) REFERENCES whatsapp_instances(id) ON DELETE SET NULL
);

-- ============================================================================
-- CATÁLOGO DE SERVIÇOS & PROCEDIMENTOS RELACIONAL (Multi-Tenant)
-- ============================================================================

CREATE TABLE IF NOT EXISTS service_catalog (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    duration_min INTEGER NOT NULL,
    price_single REAL NOT NULL,
    price_package_4x REAL,
    recommended_deposit REAL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_services_tenant ON service_catalog(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    full_name TEXT NOT NULL,
    birth_date TEXT,
    active_alerts TEXT NOT NULL DEFAULT '[]', -- JSON Array: ["🚨 Alergia: Cânfora", "⚠️ Gestante"]
    shadow_memory TEXT DEFAULT '', -- Memória de longo prazo persistida pelas tools
    last_visit_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, phone_number),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone
    ON customers(tenant_id, phone_number);

CREATE TABLE IF NOT EXISTS dynamic_records (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | COMPLETED | NEEDS_REVIEW
    current_step_state TEXT DEFAULT '{}', -- JSON: controla qual pergunta o cliente está respondendo no WhatsApp
    form_data TEXT NOT NULL DEFAULT '{}', -- JSON com todas as respostas estruturadas do nicho
    ai_executive_summary TEXT, -- Resumo executivo em bullets gerado pelo Gemini
    physical_sheet_code TEXT, -- Código único caso tenha vindo de um QR Code de folha impressa
    physical_sheet_photo_url TEXT,
    consent_signature TEXT DEFAULT '{}', -- JSON: accepted, timestamp, phone, hash
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_evolutions (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    source TEXT NOT NULL, -- PROFESSIONAL_VOICE | CLIENT_WHATSAPP | PAPER_OCR | WEB_PANEL
    raw_input TEXT, -- Transcrição do áudio ditado pela profissional ou texto original
    structured_notes TEXT NOT NULL DEFAULT '{}', -- JSON estruturado pela IA
    session_date TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (record_id) REFERENCES dynamic_records(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_followups (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    evolution_id TEXT,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SENT | REPLIED | ALERT_TRIGGERED
    message_sent TEXT,
    customer_reply TEXT,
    ai_sentiment TEXT, -- POSITIVE | NEUTRAL | ADVERSE_REACTION
    replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (record_id) REFERENCES dynamic_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS print_batches (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sheets_count INTEGER NOT NULL DEFAULT 50,
    qr_mode TEXT NOT NULL DEFAULT 'STATIC_TENANT', -- STATIC_TENANT | UNIQUE_PER_SHEET
    pdf_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    record_id TEXT,
    package_id TEXT,               -- Vinculo com customer_packages.id se for sessao de pacote
    session_number INTEGER,        -- Numero da sessao (ex: 1, 2, 3, 4)
    service_name TEXT NOT NULL,
    appointment_date TEXT NOT NULL, -- YYYY-MM-DD
     day_label TEXT NOT NULL,       -- Ex: 'Terça-feira (10/11)'
    start_time TEXT NOT NULL,       -- HH:MM (ex: '09:00')
    end_time TEXT NOT NULL,         -- HH:MM (ex: '10:00')
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT', -- PENDING_PAYMENT | CONFIRMED | CANCELLED | COMPLETED
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_appointments_tenant_date
    ON appointments(tenant_id, appointment_date, status);

CREATE TABLE IF NOT EXISTS customer_packages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    record_id TEXT,
    service_name TEXT NOT NULL,
    total_sessions INTEGER NOT NULL DEFAULT 4,
    sessions_completed INTEGER NOT NULL DEFAULT 0,
    price REAL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | COMPLETED | CANCELLED
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
    status TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | PROCESSED | SKIPPED_MANUAL_ANSWER
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_out_of_hours_queue_status
    ON out_of_hours_queue(tenant_id, status, created_at ASC);
