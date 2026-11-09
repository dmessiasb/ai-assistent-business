export interface VerticalPresetSeed {
  id: string;
  name: string;
  description: string;
  terminology: {
    clientLabel: string;
    professionalLabel: string;
    recordLabel: string;
    sessionLabel: string;
  };
  ai_persona: {
    role: string;
    tone: string;
    extractionInstructions: string;
  };
  form_schema: Array<{
    fieldKey: string;
    label: string;
    type: 'text' | 'boolean' | 'boolean_with_details' | 'scale_1_10' | 'select';
    questionPrompt: string;
    required: boolean;
    options?: string[];
  }>;
  alert_rules: Array<{
    fieldKey: string;
    condition: 'is_true' | 'not_empty' | 'gte';
    threshold?: number;
    severity: 'CRITICAL' | 'WARNING';
    badgeTemplate: string;
  }>;
  followup_templates: Array<{
    triggerAfterHours: number;
    messageTemplate: string;
  }>;
}

export const INITIAL_VERTICAL_PRESETS: VerticalPresetSeed[] = [
  {
    id: 'massoterapia_estetica',
    name: 'ADEN Massoterapia (Catálogo + Anamnese Invisível)',
    description: 'Configuração personalizada para ADEN Massoterapia com catálogo de procedimentos, durações, valores avulsos/pacotes e anamnese conversacional.',
    terminology: {
      clientLabel: 'Cliente',
      professionalLabel: 'Massoterapeuta (ADEN)',
      recordLabel: 'Ficha de Pré-Atendimento',
      sessionLabel: 'Sessão de Massoterapia',
    },
    ai_persona: {
      role: 'Atendente virtual humana e acolhedora da ADEN Massoterapia',
      tone: 'Leve, natural, simpática e sem parecer robô ou formulário',
      extractionInstructions:
        'Catálogo oficial ADEN Massoterapia: 1) Massagem Relaxante (60min - R$ 120 avulsa | Pacote 4 sessões R$ 420); 2) Drenagem Linfática (50min - R$ 80 avulsa | Pacote 4 sessões R$ 280); 3) Massagem com Pedras Quentes (75min - R$ 170 avulsa | Pacote 4 sessões R$ 600); 4) Thai Massage (60min - R$ 160 avulsa | Pacote 4 sessões R$ 560); 5) Massagem Localizada Foco na Queixa (30min - R$ 80 avulsa | Pacote 4 sessões R$ 280). Extraia procedimento escolhido (e se quer sessão avulsa ou pacote de 4 sessões), para quem é a sessão, nível de dor/tensão (0 a 10), alergias, condições de saúde (pressão alta, cirurgia, circulatório, gestação) e preferência de dia/horário.',
    },
    form_schema: [
      {
        fieldKey: 'queixa_principal',
        label: 'Procedimento Escolhido / Modalidade (Avulso ou Pacote 4 Sessões)',
        type: 'text',
        questionPrompt:
          'Qual técnica você gostaria de agendar? Temos:\n• Massagem Relaxante (60 min): R$ 120 (ou pacote 4 sessões por R$ 420)\n• Drenagem Linfática (50 min): R$ 80 (pacote 4 por R$ 280)\n• Massagem com Pedras Quentes (75 min): R$ 170 (pacote 4 por R$ 600)\n• Thai Massage (60 min): R$ 160 (pacote 4 por R$ 560)\n• Massagem Localizada - Foco na Queixa (30 min): R$ 80 (pacote 4 por R$ 280)',
        required: true,
      },
      {
        fieldKey: 'para_quem_e_nivel_dor',
        label: 'Modalidade (Avulsa/Pacote) e Queixa/Nível de Dor',
        type: 'text',
        questionPrompt:
          'Você prefere fazer a sessão avulsa ou fechar o pacote de 4 sessões?',
        required: true,
      },
      {
        fieldKey: 'alergias',
        label: 'Alergias (Cosméticos, Óleos, Medicamentos)',
        type: 'boolean_with_details',
        questionPrompt:
          'Entendi! Tem alguma alergia a óleo, creme ou medicamento que seja bom evitar na sessão?',
        required: true,
      },
      {
        fieldKey: 'historico_saude',
        label: 'Condições de Saúde (Pressão, Cirurgia, Circulatório ou Gestação)',
        type: 'boolean_with_details',
        questionPrompt:
          'Combinado. E existe alguma condição de saúde importante que eu precise saber antes do atendimento (como pressão alta, cirurgia recente, questão circulatória ou gestação)?',
        required: true,
      },
      {
        fieldKey: 'preferencia_horario',
        label: 'Dia e Horário Solicitado para Agendamento',
        type: 'text',
        questionPrompt:
          'Maravilha, já deixei tudo certinho aqui! Qual melhor dia e horário fica bom?',
        required: true,
      },
    ],
    alert_rules: [
      {
        fieldKey: 'gestante',
        condition: 'is_true',
        severity: 'WARNING',
        badgeTemplate: '⚠️ Gestante ({{details}})',
      },
      {
        fieldKey: 'alergias',
        condition: 'is_true',
        severity: 'CRITICAL',
        badgeTemplate: '🚨 Alergia: {{details}}',
      },
      {
        fieldKey: 'historico_saude',
        condition: 'is_true',
        severity: 'CRITICAL',
        badgeTemplate: '🚨 Atenção Clínica: {{details}}',
      },
      {
        fieldKey: 'nivel_dor',
        condition: 'gte',
        threshold: 8,
        severity: 'WARNING',
        badgeTemplate: '🔥 Dor Aguda ({{value}}/10)',
      },
    ],
    followup_templates: [
      {
        triggerAfterHours: 24,
        messageTemplate:
          'Oi {{clientName}}! Tudo bem? Passando para saber como seu corpo reagiu após a sessão de ontem. A dor/tensão aliviou? Sentiu algum desconforto?',
      },
    ],
  },
  {
    id: 'pet_shop_banho_tosa',
    name: 'Pet Shop & Clínica Veterinária (Check-in Pet)',
    description: 'Exemplo de adaptação multi-nicho: Ficha de anamnese e check-in para banho, tosa e atendimento pet.',
    terminology: {
      clientLabel: 'Tutor / Pet',
      professionalLabel: 'Tosador / Veterinário',
      recordLabel: 'Ficha de Check-in Pet',
      sessionLabel: 'Atendimento / Banho & Tosa',
    },
    ai_persona: {
      role: 'Assistente carinhoso de Pet Shop e Estética Animal',
      tone: 'Alegre, cuidadoso e objetivo',
      extractionInstructions:
        'Extraia nome e raça do pet, temperamento (se morde ou tem medo de secador), alergias de pele/shampoo, presença de pulgas/carrapatos ou nós nos pelos.',
    },
    form_schema: [
      {
        fieldKey: 'nome_raca_pet',
        label: 'Nome, Raça e Idade do Pet',
        type: 'text',
        questionPrompt: 'Qual o nome, a raça e a idade do seu pet?',
        required: true,
      },
      {
        fieldKey: 'temperamento_reativo',
        label: 'Pet é reativo/bravo ou tem medo de soprador?',
        type: 'boolean_with_details',
        questionPrompt: 'Ele fica estressado com secador/soprador ou costuma morder ao mexer nas patinhas/orelhas?',
        required: true,
      },
      {
        fieldKey: 'alergia_dermatologica',
        label: 'Possui dermatite, feridas ou alergia a shampoo/perfume?',
        type: 'boolean_with_details',
        questionPrompt: 'Ele tem alguma alergia de pele, precisa de shampoo terapêutico ou não pode usar perfume?',
        required: true,
      },
    ],
    alert_rules: [
      {
        fieldKey: 'temperamento_reativo',
        condition: 'is_true',
        severity: 'WARNING',
        badgeTemplate: '⚠️ Manejo Cuidadoso: {{details}}',
      },
      {
        fieldKey: 'alergia_dermatologica',
        condition: 'is_true',
        severity: 'CRITICAL',
        badgeTemplate: '🚨 Pele Sensível/Alergia: {{details}}',
      },
    ],
    followup_templates: [
      {
        triggerAfterHours: 24,
        messageTemplate:
          'Oi {{clientName}}! O pet ficou bem após o atendimento de ontem? Qualquer observação estamos por aqui!',
      },
    ],
  },
  {
    id: 'oficina_estetica_automotiva',
    name: 'Oficina & Estética Automotiva (Checklist de Entrada)',
    description: 'Exemplo de adaptação multi-nicho: Checklist de entrada de veículos por áudio/foto.',
    terminology: {
      clientLabel: 'Proprietário / Veículo',
      professionalLabel: 'Consultor Técnico',
      recordLabel: 'Checklist de Vistoria',
      sessionLabel: 'Ordem de Serviço',
    },
    ai_persona: {
      role: 'Consultor técnico de recepção automotiva',
      tone: 'Profissional, claro e técnico',
      extractionInstructions:
        'Extraia modelo/placa do veículo, serviço desejado, barulhos ou falhas relatadas, avarias prévias na pintura e itens deixados no interior.',
    },
    form_schema: [
      {
        fieldKey: 'veiculo_servico',
        label: 'Veículo e Serviço Solicitado',
        type: 'text',
        questionPrompt: 'Qual o modelo do veículo e o que vamos realizar nele hoje?',
        required: true,
      },
      {
        fieldKey: 'avarias_previas',
        label: 'Possui riscos, amassados ou luzes de painel acesas?',
        type: 'boolean_with_details',
        questionPrompt: 'Há algum risco/avaria prévia ou luz de alerta acesa no painel que devemos registrar?',
        required: true,
      },
    ],
    alert_rules: [
      {
        fieldKey: 'avarias_previas',
        condition: 'is_true',
        severity: 'WARNING',
        badgeTemplate: '⚠️ Avaria Prévia: {{details}}',
      },
    ],
    followup_templates: [
      {
        triggerAfterHours: 48,
        messageTemplate:
          'Olá {{clientName}}! Tudo 100% com o veículo após o nosso serviço? Ficou alguma dúvida?',
      },
    ],
  },
];
