export interface GeminiCustomerProfile {
  fullName: string;
  firstName: string;
  isReturningCustomer: boolean;
  pastEvolutionsSummary?: string;
  activeAppointmentsSummary?: string;
}

export interface GeminiProcessInput {
  text?: string;
  mediaBase64?: string;
  mimeType?: string; // Ex: 'audio/ogg', 'image/jpeg'
  systemInstruction?: string;
  skillMarkdown?: string; // Skill e Guardrails de Segurança específicos da empresa
  customerProfile?: GeminiCustomerProfile;
  extractionSchemaHint?: Record<string, unknown> | unknown[];
  existingData?: Record<string, unknown>;
  missingFieldsHint?: Array<{ fieldKey: string; label: string; questionPrompt: string }>;
  nextFieldPrompt?: string;
  recentHistory?: string;
  apiKeyOverride?: string; // Chave Gemini exclusiva da empresa (Tenant)
  modelOverride?: string;  // Modelo exclusivo da empresa (Tenant)
}

export interface GeminiProcessResult {
  transcription: string;
  extractedData: Record<string, unknown>;
  executiveSummary?: string;
  isClientQuestion?: boolean;
  conversationalReply?: string;
  usedFallback: boolean;
}

export class GeminiService {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = (process.env.GEMINI_API_KEY || '').trim();
    this.model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  public setCredentials(apiKey: string, model?: string): void {
    this.apiKey = apiKey.trim();
    process.env.GEMINI_API_KEY = this.apiKey;
    if (model && model.trim()) {
      this.model = model.trim();
      process.env.GEMINI_MODEL = this.model;
    }
  }

  public getModelName(): string {
    return this.model;
  }

  /**
   * Processa texto, áudio (.ogg do WhatsApp) ou imagem (foto de ficha física)
   * com memória de cliente recorrente e personalização pelo nome.
   */
  public async processInputAndExtractJson(input: GeminiProcessInput): Promise<GeminiProcessResult> {
    const activeApiKey = (
      input.apiKeyOverride ||
      process.env.GEMINI_API_KEY ||
      this.apiKey ||
      ''
    ).trim();

    if (!activeApiKey) {
      return this.runLocalHeuristicFallback(input);
    }

    const promptLines = [
      input.systemInstruction ||
        'Você é uma atendente virtual humana, acolhedora, empática e altamente atenciosa via WhatsApp.',
    ];

    if (input.skillMarkdown && input.skillMarkdown.trim()) {
      promptLines.push(
        `=== SKILL & GUARDRAILS DE SEGURANÇA DA EMPRESA (SIGA ESTRITAMENTE) ===\n${input.skillMarkdown.trim()}\n======================================================================`
      );
    }

    if (input.customerProfile) {
      const cp = input.customerProfile;
      promptLines.push(
        `=== PERFIL E MEMÓRIA DO CLIENTE ATUAL ===`,
        `- Nome do Cliente: ${cp.fullName} (Chame-o(a) pelo primeiro nome: "${cp.firstName}", sem repetir a cada frase)`,
        `- Cliente Recorrente / Já conhecido: ${cp.isReturningCustomer ? 'SIM (Trate com proximidade, lembre-se do histórico dele e NÃO repita perguntas básicas!)' : 'Novo atendimento'}`,
        cp.activeAppointmentsSummary
          ? `- AGENDA E PACOTES GUARDADOS NO SISTEMA: ${cp.activeAppointmentsSummary} (NUNCA diga que não encontrou na conversa ou no sistema!)`
          : `- Agenda e Pacotes: Nenhum agendamento ativo prévio.`,
        cp.pastEvolutionsSummary
          ? `- Histórico de Sessões Anteriores: ${cp.pastEvolutionsSummary}`
          : `- Histórico de Sessões Anteriores: Nenhuma sessão anterior registrada.`,
        `=========================================`
      );
    }

    if (input.recentHistory) {
      // Sanitiza apelidos antigos ("Adenzinha") do histórico para nunca contradizer o nome oficial definido na Skill (Adenilde)
      const sanitizedHistory = input.recentHistory.replace(/Adenzinha/gi, 'Adenilde');
      promptLines.push(`Histórico recente da conversa no WhatsApp:\n${sanitizedHistory}`);
    }

    if (input.existingData && Object.keys(input.existingData).length > 0) {
      promptLines.push(
        `Dados JÁ COLETADOS do cliente (PROIBIDO perguntar novamente o que já está aqui!): ${JSON.stringify(input.existingData)}`
      );
    }

    if (input.missingFieldsHint && input.missingFieldsHint.length > 0) {
      promptLines.push(
        `Informações que ainda faltam descobrir naturalmente na conversa (apenas se ainda não tiverem sido respondidas): ${JSON.stringify(input.missingFieldsHint)}`
      );
    }

    promptLines.push(
      'REGRAS DE OURO PARA EXTRAÇÃO E RESPOSTA ("conversationalReply"):',
      '1. Se houver um áudio anexado, transcreva FIELMENTE palavra por palavra em português no campo "transcription".',
      '2. IDENTIDADE E SINGULARIDADE (OBRIGATÓRIO): Você é Adenilde. O atendimento é INDIVIDUAL, feito apenas por você (uma única pessoa). PROIBIDO falar no plural ("nós", "fazemos", "usamos", "temos equipe", "nossa clínica"). Fale SEMPRE na primeira pessoa do singular ("eu atendo", "eu uso", "eu tenho livre", "meu espaço").',
      '3. PROIBIÇÃO ABSOLUTA DE VOCATIVOS ÍNTIMOS OU CARINHOSOS (RIGOROSO): É TERMINANTEMENTE PROIBIDO chamar o cliente por "meu bem", "amor", "meu amor", "anjo", "meu anjo", "querido", "querida", "lindo", "linda", "flor", "coração". Trate SEMPRE com educação profissional, respeito e acolhimento simpático ("Olá", "Com certeza", "Combinado", "Tudo bem?", "Você prefere...").',
      '4. NATURALIDADE NO NOME DO CLIENTE: PROIBIDO colocar o nome do cliente em todas as mensagens! Em um diálogo natural de WhatsApp, as pessoas NÃO dizem o nome do outro a cada frase. Use o nome do cliente no MÁXIMO 1 vez no início da conversa ou se for estritamente necessário. Se a conversa já está em andamento, responda direto sem mencionar o nome!',
      '5. AGENDA E PACOTES (SEM AMNÉSIA E SEM RECORRÊNCIAS INVENTADAS): NUNCA diga que "o pacote é semanal" ou que "será toda semana no mesmo horário"! Cada sessão de um pacote é agendada individualmente. NUNCA diga que não achou no sistema se o cliente já tem agendamento ativo informado.',
      '6. PROIBIDO CONFIRMAR PAGAMENTO/SINAL POR CONTA PRÓPRIA: Se o cliente disser que fez o Pix ou mandar comprovante, NUNCA diga que o pagamento caiu ou que já está confirmado! Responda apenas que recebeu e que vai conferir na conta para confirmar logo em seguida.',
      '7. VESTIMENTA (REGRAS RÍGIDAS DE CONDUTA):',
      '   - Masculina: bermuda leve.',
      '   - Feminina: calcinha e sutiã.',
      '   - PROIBIDO dizer que pode ficar nu ou "a critério". Se o cliente perguntar se faz "final feliz" ou qualquer insinuação sexual, recuse com firmeza e respeito: informe que o atendimento é estritamente massoterapia terapêutica profissional.',
      '8. TOLERÂNCIA E NEGOCIAÇÃO DE VALORES: Se o cliente pedir para pagar um sinal menor (ex: oferecer R$ 20 ou R$ 30 em vez de R$ 36), tenha flexibilidade e bom senso, aceite com simpatia (ex: "Sem problemas, pode ser R$ 30 então!") para fechar o agendamento sem atrito.',
      '9. BREVIDADE REAL DE WHATSAPP: Mensagens curtas, diretas e naturais (máximo 1 a 2 frases curtas, até 130 caracteres).',
      '10. Retorne APENAS um objeto JSON válido (sem blocos markdown) no seguinte formato exato:',
      '{',
      '  "transcription": "Transcrição fiel completa do áudio/imagem ou o próprio texto enviado",',
      '  "extractedData": { ...somente campos efetivamente respondidos pelo cliente... },',
      '  "isClientQuestion": true,',
      '  "conversationalReply": "Resposta CURTA (1 a 2 frases curtas), humana e natural para enviar no WhatsApp",',
      '  "executiveSummary": "Resumo curto em até 3 bullets das informações importantes"',
      '}'
    );

    if (input.extractionSchemaHint) {
      promptLines.push(
        `Esquema de campos de "extractedData": ${JSON.stringify(input.extractionSchemaHint)}`
      );
    }

    if (input.text) {
      promptLines.push(`Mensagem atual do cliente: "${input.text}"`);
    }

    const parts: Array<Record<string, unknown>> = [{ text: promptLines.join('\n') }];

    if (input.mediaBase64 && input.mimeType) {
      const cleanMimeType = input.mimeType.split(';')[0].trim();
      parts.push({
        inlineData: {
          mimeType: cleanMimeType,
          data: input.mediaBase64,
        },
      });
    }

    const modelsToTry = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.8-flash'];

    const endpointsToTry: string[] = [];
    for (const m of modelsToTry) {
      endpointsToTry.push(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${activeApiKey}`
      );
    }

    const errors: string[] = [];
    for (const url of endpointsToTry) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(35000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.25,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (!response.ok) {
          const errBody = await response.text();
          errors.push(`[${response.status}] ${errBody}`);
          continue;
        }

        const resultJson = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        const rawText = resultJson.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const cleanedJsonText = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleanedJsonText) as Partial<GeminiProcessResult>;

        const cleanReply = (parsed.conversationalReply || '')
          .replace(/Adenzinha/gi, 'Adenilde')
          .replace(/\b(meu\s+bem|meu\s+amor|meu\s+anjo|querid[oa]|lind[oa]|flor|cora[cç][aã]o)\b[!,.]?\s*/gi, '')
          .trim();

        return {
          transcription: parsed.transcription || input.text || '',
          extractedData: parsed.extractedData || {},
          isClientQuestion: Boolean(parsed.isClientQuestion),
          conversationalReply: cleanReply,
          executiveSummary: parsed.executiveSummary || '',
          usedFallback: false,
        };
      } catch (err: any) {
        errors.push(err?.message || String(err));
      }
    }

    console.warn(`[GeminiService] Aviso ao chamar API:\n${errors.join('\n')}\nUsando heurística local.`);
    return this.runLocalHeuristicFallback(input);
  }

  private runLocalHeuristicFallback(input: GeminiProcessInput): GeminiProcessResult {
    const baseText =
      input.text ||
      (input.mediaBase64 ? '[Áudio recebido — aguardando transcrição]' : '');
    const firstName = input.customerProfile?.firstName || '';

    let fallbackReply = '';
    if (/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|opa|e\s+a[ií])[\s!.,?]*$/i.test(baseText.trim())) {
      fallbackReply = firstName
        ? `Olá, ${firstName}! Boa noite, tudo bem? 😊 Que bom falar com você! Como posso te ajudar hoje com o seu agendamento?`
        : `Olá! Boa noite, tudo bem? 😊 Como posso te ajudar hoje?`;
    } else if (/qual\s+(?:o\s+)?seu\s+nome|com\s+quem\s+(?:eu\s+)?falei|quem\s+est[aá]\s+falando/i.test(baseText)) {
      fallbackReply = firstName
        ? `Aqui é a Adenilde, ${firstName}! 😊`
        : `Aqui é a Adenilde! 😊`;
    } else if (/ofensivo|nem\s+sabe\s+meu\s+nome|j[aá]\s+avisei/i.test(baseText)) {
      fallbackReply = firstName
        ? `Me perdoe de verdade, ${firstName}! 😅 Foi uma falha aqui na mensagem automática. Já deixei tudo anotado certinho no seu cadastro. Qual dia e horário fica melhor pra você vir fazer a sua sessão?`
        : `Me perdoe pela falha na mensagem anterior! 😅 Qual dia e horário fica melhor para agendarmos a sua sessão?`;
    }

    return {
      transcription: baseText,
      extractedData: {},
      isClientQuestion: Boolean(fallbackReply) || /\?|como\s+funciona|como\s+[eé]\s+o\s+esquema|completa|endere[cç]o|onde\s+fica/i.test(baseText),
      conversationalReply: fallbackReply,
      executiveSummary: baseText ? `Resumo automático: ${baseText.slice(0, 120)}` : undefined,
      usedFallback: true,
    };
  }
}

export const geminiService = new GeminiService();
