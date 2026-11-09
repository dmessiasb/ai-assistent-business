# Guia Completo de Configuração: API Gemini 2.5 Flash + ADEN Massoterapia

Este guia mostra como ativar **100% da Inteligência Artificial gratuita do Google Gemini (`gemini-2.5-flash`)** para transcrição nativa de áudios do WhatsApp (`.ogg`), leitura de fotos de fichas físicas e extração inteligente baseada no catálogo da **ADEN Massoterapia**.

---

## Passo 1: Gerar sua Chave Gratuita (`GEMINI_API_KEY`) no Google AI Studio

1. Acesse o painel oficial do Google AI Studio: **https://aistudio.google.com/apikey**
2. Faça login com sua conta Google.
3. Clique no botão azul **"Create API key"** (Criar chave de API).
4. Copie a chave gerada (ela começa com `AIzaSy...`).
   - *Custo:* **R$ 0,00 (Free Tier)** — inclui até 1.500 requisições gratuitas por dia no modelo `gemini-2.5-flash`, com suporte nativo a áudio em português, texto e imagem.

---

## Passo 2: Inserir a Chave na Ferramenta (2 Opções)

### Opção A — Pelo Painel Web em 1 Clique (Mais Rápido)
1. Com o servidor rodando (`npm run dev`), abra **http://localhost:3000**.
2. No canto superior direito, clique no botão roxo **"🔑 Configurar Chave Gemini (Voz/IA)"**.
3. Cole sua chave `AIzaSy...` e confirme.
4. O sistema fará um teste imediato na API do Google, ativará a chave em memória e salvará automaticamente no seu arquivo [.env](file:///c:/_dev/atendimento_whatsapp/.env).
5. O selo no topo mudará na hora para: `🟢 Online | Gemini: Ativo`.

### Opção B — Editando diretamente o arquivo `.env`
Abra o arquivo [.env](file:///c:/_dev/atendimento_whatsapp/.env) na raiz do projeto e preencha:
```env
PORT=3000
HOST=0.0.0.0
HUB_MASTER_API_KEY=dev-master-key-change-me
GEMINI_API_KEY=AIzaSySUA_CHAVE_AQUI
GEMINI_MODEL=gemini-2.5-flash
SQLITE_DB_PATH=./data/database.sqlite
WHATSAPP_AUTH_DIR=./data/whatsapp_sessions
```

---

## Passo 3: O que o Gemini 2.5 Flash passa a fazer automaticamente quando ativo

1. **Transcrição Real de Áudios (`.ogg`) no WhatsApp:**
   - Quando a cliente responde por áudio (como nos 3 áudios enviados durante o teste!), o [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) baixa o buffer de áudio e envia direto para o [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts).
   - O Gemini transcreve exatamente o que a pessoa falou (ex.: *"Prefiro na quinta-feira às 14h, e não tenho pressão alta não"*) e já preenche os campos correspondentes da ficha em uma única chamada.
2. **Modo Ditado por Voz da Massoterapeuta (ADEN Massoterapia):**
   - A profissional (`(41) 99176-9268`) pode mandar um áudio rápido pós-sessão e o Gemini estrutura a evolução clínica do cliente.
3. **Leitura de Foto da Ficha Impressa (Gemini Vision):**
   - Se a profissional anotar no bloco físico da **ADEN Massoterapia** e mandar uma foto da folha no WhatsApp, o Gemini lê as marcações e salva no banco digital.

---

## Passo 4: Catálogo Oficial Configurado — ADEN Massoterapia

O sistema já está configurado em [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts) e [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) com todos os procedimentos, durações e valores do catálogo da **ADEN Massoterapia**:

| Procedimento / Técnica | Duração | Valor Unitário | Pacote (4 Sessões) |
| :--- | :---: | :---: | :---: |
| **Massagem Relaxante** | 60 min | R$ 120,00 | R$ 420,00 |
| **Drenagem Linfática** | 50 min | R$ 80,00 | R$ 280,00 |
| **Massagem com Pedras Quentes** | 75 min | R$ 170,00 | R$ 600,00 |
| **Thai Massage** | 60 min | R$ 160,00 | R$ 560,00 |
| **Massagem Localizada (Foco na Queixa)** | 30 min | R$ 80,00 | R$ 280,00 |

- **WhatsApp da Clínica configurado:** `(41) 99176-9268` (`5541991769268`)
- **Identidade Visual do Bloco Físico (`/api/v1/tenants/tenant_demo_estetica/print-preview`):** Verde Sálvia (`#5F7358`) com QR Code apontando para o atendimento da **ADEN Massoterapia**.

---

## Passo 5: Como Liberar para Todos os Clientes (Quando sair do Modo Teste)

Atualmente, em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts#L22-L24), a trava `ALLOWED_TEST_JIDS` protege seu WhatsApp pessoal respondendo apenas na conversa de teste (`237327075004656@lid`).

Quando for conectar o WhatsApp exclusivo da clínica (**`(41) 99176-9268`**):
- Você pode adicionar novos números de teste em `ALLOWED_TEST_JIDS`, ou
- Desativar o filtro de JID para que a conta comercial da **ADEN Massoterapia** atenda automaticamente qualquer cliente que chamar para agendar!
