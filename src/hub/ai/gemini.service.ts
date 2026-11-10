export interface GeminiProcessInput {
  systemInstruction: string; // Prompt compilado dinamicamente pelo orquestrador
  text?: string;
  mediaBase64?: string;
  mimeType?: string; // Ex: 'audio/ogg', 'image/jpeg'
  recentHistory?: Array<{ role: 'user' | 'model'; text: string }>;
  tools?: any[]; // Declaração de Tools para Function Calling
  apiKeyOverride?: string;
  modelOverride?: string;
}

export interface GeminiProcessResult {
  transcription?: string;
  conversationalReply: string;
  functionCalls?: Array<{ name: string; args: Record<string, any> }>;
  tokensUsed: number;
}

export class GeminiService {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = (process.env.GEMINI_API_KEY || '').trim();
    this.model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
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
   * Processador Agnóstico de IA via Google Gemini.
   * Não possui regras rígidas ou nomes de clientes/empresas embutidos na classe.
   * Aceita systemInstruction dinâmica, histórico recente, mídias e ferramentas de escrita.
   */
  public async processInputAndExtractJson(input: GeminiProcessInput): Promise<GeminiProcessResult> {
    const activeApiKey = (
      input.apiKeyOverride ||
      process.env.GEMINI_API_KEY ||
      this.apiKey ||
      ''
    ).trim();

    if (!activeApiKey) {
      return this.runLocalAgnosticFallback(input);
    }

    // Monta o histórico de contents no formato nativo da API do Gemini
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];

    if (input.recentHistory && Array.isArray(input.recentHistory) && input.recentHistory.length > 0) {
      for (const item of input.recentHistory) {
        if (item.text && item.text.trim()) {
          contents.push({
            role: item.role === 'model' ? 'model' : 'user',
            parts: [{ text: item.text.trim() }],
          });
        }
      }
    }

    // Prepara a mensagem/mídia atual do usuário
    const currentParts: Array<Record<string, unknown>> = [];

    if (input.mediaBase64 && input.mimeType) {
      const cleanMimeType = input.mimeType.split(';')[0].trim();
      currentParts.push({
        inlineData: {
          mimeType: cleanMimeType,
          data: input.mediaBase64,
        },
      });
      // Instrução embutida para transcrição quando houver mídia
      currentParts.push({
        text: input.text && input.text.trim()
          ? input.text.trim()
          : 'Por favor, processe e transcreva a mensagem acima fielmente em português caso seja áudio, e responda naturalmente ao cliente.',
      });
    } else if (input.text && input.text.trim()) {
      currentParts.push({ text: input.text.trim() });
    } else {
      currentParts.push({ text: 'Olá!' });
    }

    contents.push({
      role: 'user',
      parts: currentParts,
    });

    const requestBody: Record<string, unknown> = {
      contents,
      systemInstruction: {
        parts: [{ text: input.systemInstruction || 'Você é um assistente virtual acolhedor, profissional e prestativo.' }],
      },
      generationConfig: {
        temperature: 0.3,
      },
    };

    if (input.tools && Array.isArray(input.tools) && input.tools.length > 0) {
      requestBody.tools = input.tools;
    }

    const preferredModel = input.modelOverride || this.model || 'gemini-2.5-flash';
    const modelsToTry = [preferredModel, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.8-flash'].filter(
      (m, idx, arr) => arr.indexOf(m) === idx
    );

    const errors: string[] = [];
    for (const modelCandidate of modelsToTry) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelCandidate}:generateContent?key=${activeApiKey}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(12000), // Timeout rápido para evitar latência
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errBody = await response.text();
          errors.push(`[${response.status}] ${errBody.slice(0, 150)}`);
          continue;
        }

        const resultJson = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                functionCall?: { name: string; args: Record<string, any> };
              }>;
            };
          }>;
          usageMetadata?: {
            totalTokenCount?: number;
          };
        };

        const candidateParts = resultJson.candidates?.[0]?.content?.parts || [];
        const textParts: string[] = [];
        const functionCalls: Array<{ name: string; args: Record<string, any> }> = [];

        for (const part of candidateParts) {
          if (part.text) {
            textParts.push(part.text);
          }
          if (part.functionCall) {
            functionCalls.push({
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            });
          }
        }

        const tokensUsed = resultJson.usageMetadata?.totalTokenCount || 0;
        const rawConversationalReply = textParts.join('\n').trim();

        return {
          transcription: input.text || (input.mediaBase64 ? 'Áudio processado' : undefined),
          conversationalReply: rawConversationalReply,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          tokensUsed,
        };
      } catch (err: any) {
        errors.push(err?.message || String(err));
      }
    }

    console.warn(`[GeminiService] Falha ao comunicar com os modelos [${modelsToTry.join(', ')}]:\n${errors.join('\n')}`);
    return this.runLocalAgnosticFallback(input);
  }

  private runLocalAgnosticFallback(input: GeminiProcessInput): GeminiProcessResult {
    const rawText = input.text || '';
    let fallbackReply = 'Olá! Recebi sua mensagem e já estou verificando para te responder da melhor forma. Como posso te ajudar hoje?';

    if (/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|opa|e\s+a[ií])[\s!.,?]*$/i.test(rawText.trim())) {
      fallbackReply = 'Olá, tudo bem? Que bom falar com você! Como posso te ajudar hoje? 😊';
    }

    return {
      transcription: rawText,
      conversationalReply: fallbackReply,
      functionCalls: undefined,
      tokensUsed: 0,
    };
  }
}

export const geminiService = new GeminiService();
