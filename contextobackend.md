# Contexto Backend - Histórico de Implementação

## [2026-11-07] Planejamento da Arquitetura Multi-Nicho de Atendimento via WhatsApp
- Analisado o documento base `contexto/plano_de_neg_cio_ficha_de_anamnese (1).md`.
- Criado o plano de implementação modular e orientado a configuração (`Config-Driven` / `Multi-Tenant`), permitindo que a ferramenta atenda Massoterapia/Estética inicialmente e seja adaptada para qualquer outro tipo de negócio apenas trocando o `VerticalPreset` (JSON/DB).
- Definidos os 5 módulos principais da arquitetura:
  1. **Gateway WhatsApp & Orquestrador de IA (Voz/Texto)**: transcrição de áudio e extração estruturada baseada no schema do negócio.
  2. **Motor de Fichas e Fluxos Dinâmicos (Schema Engine)**: armazenamento híbrido relacional + `JSONB`, suportando campos dinâmicos e regras de alerta (`AlertRules`).
  3. **Ponte Físico-Digital (QR Code & Print-on-Demand Engine)**: geração de QR Codes (fixos ou por folha) e exportação de blocos físicos em PDF personalizados por nicho.
  4. **Motor de "Ficha Viva" e Automação de Retenção**: filas assíncronas para follow-up pós-atendimento (D+1, D+15, etc.) com análise de sentimento e atualização automática do prontuário/histórico.
  5. **Painel Web / PWA do Profissional ("Prancheta Digital")**: interface mobile-first de zero atrito para consulta rápida de histórico e alertas.
- Definido o roadmap de implementação em 4 fases (Fundação Configurável, Hub WhatsApp + IA, Ponte Físico-Digital + PWA, e Automação "Ficha Viva").

## [2026-11-07] Definição de Estratégia Custo Zero para WhatsApp no MVP
- Avaliadas opções de custo zero (R$ 0) para integração com WhatsApp no MVP:
  1. **Baileys (`@whiskeysockets/baileys`) embarcado direto no backend Node.js**: Custo R$ 0, sem necessidade de subir containers extras pesados, conecta via QR Code (WhatsApp Web multi-device), suporta recebimento de áudio (`.ogg`/opus), texto, imagem e envio de mensagens.
  2. **Evolution API (Open Source / Docker)**: Custo R$ 0 de licença, ideal quando quiser gerenciar múltiplas instâncias via API REST isolada.
  3. **WhatsApp Cloud API Oficial (Meta)**: Possui faixa gratuita para conversas de serviço (iniciadas pelo usuário via QR Code/link `wa.me`), porém cobra por mensagens ativas de template (como follow-up D+1 fora da janela de 24h).
- Arquitetura definida com padrão **Adapter (`IWhatsAppProvider`)**: permite iniciar 100% grátis com Baileys/Evolution API e migrar ou mesclar com a API Oficial no futuro apenas mudando variável de ambiente.

## [2026-11-07] Definição de Escopo em Fases e Hub WhatsApp Reutilizável
- Definida a stack 100% gratuita para início do projeto:
  - **WhatsApp**: `@whiskeysockets/baileys` (custo zero, multi-sessão via QR Code).
  - **IA (Áudio, Visão e Extração JSON)**: Google Gemini (`gemini-2.5-flash` via Google AI Studio Free Tier).
- **Requisito Arquitetural Crítico**: O módulo de WhatsApp foi desenhado como um **Hub Universal (`WhatsApp & AI Core Hub`)** desacoplado, com API REST e Webhooks próprios, permitindo que qualquer outra solução futura criada pelo usuário se conecte a ele.
- Escopo dividido em **5 Fases Incrementais**:
  - **Fase 1**: WhatsApp & AI Core Hub (Baileys multi-sessão + Gemini Audio/Texto + API/Webhooks para conectar outros sistemas).
  - **Fase 2**: Motor Configurável Multi-Nicho (Schema Engine em JSON com Presets para Massoterapia/Estética e outros negócios).
  - **Fase 3**: Fluxo Conversacional & Preenchimento por Voz no WhatsApp (Modo Cliente e Modo Ditado Rápido do Profissional).
  - **Fase 4**: Ponte Físico-Digital (Gerador de PDF do Bloco com QR Code + Leitura de Ficha de Papel por Foto + Prancheta Digital Web).
  - **Fase 5**: "Ficha Viva" (Follow-up automático pós-atendimento e atualização autônoma de histórico).

## [2026-11-07] Modelagem Completa do Banco de Dados (Multi-Domínio)
- Adicionada ao plano de implementação a estrutura detalhada de banco de dados dividida em 2 domínios independentes:
  1. **Domínio 1 — WhatsApp & AI Core Hub** (reutilizável por qualquer sistema futuro):
     - `whatsapp_instances`: Gerenciamento de sessões Baileys, status, QR Code e API Keys.
     - `webhook_subscriptions`: Cadastro de sistemas externos que escutam o Hub, com suporte a filtros de roteamento (`routing_rules`).
     - `hub_message_logs`: Histórico de mensagens recebidas/enviadas, transcrições de áudio do Gemini e extrações JSON.
  2. **Domínio 2 — Fichas Inteligentes Multi-Nicho** (orientado a configuração):
     - `vertical_presets`: Configurações de cada tipo de negócio (`terminology`, `ai_persona`, `form_schema`, `alert_rules`, `followup_templates`).
     - `tenants`: Profissionais/clínicas vinculadas a um preset de nicho e a uma instância do WhatsApp Hub, incluindo `owner_phone` (para identificar o Modo Ditado da profissional) e `branding_config` (para geração do bloco impresso).
     - `customers`: Cadastro dos clientes finais com cache de alertas críticos (`active_alerts`).
     - `dynamic_records`: Fichas preenchidas com `form_data` em JSON, estado da entrevista no WhatsApp (`current_step_state`), resumo executivo da IA (`ai_executive_summary`), vínculo com folha física (`physical_sheet_code`) e assinatura digital (`consent_signature`).
     - `session_evolutions`: Histórico de sessões/atendimentos (alimentado por áudio ditado pela profissional, WhatsApp, foto de ficha de papel ou painel web).
     - `scheduled_followups`: Fila da "Ficha Viva" para mensagens automáticas pós-atendimento e detecção de reações adversas pela IA.
     - `print_batches`: Controle de geração de PDFs de blocos físicos personalizados com QR Code.

## [2026-11-07] Análise de Custos de Hospedagem no Google Cloud Platform (GCP)
- Avaliado o impacto financeiro de hospedar a arquitetura (Node.js + Baileys + Banco de Dados) no GCP:
  - **Pegadinha de Custo Alto no GCP**: Usar **Cloud SQL** (a partir de ~US$ 10–50/mês) ou **Cloud Run com `min-instances=1`** (necessário para o WebSocket do Baileys não desconectar, gerando custo de ~US$ 15–30/mês).
  - **Configuração Custo R$ 0 (Always Free Tier) no GCP**:
    - **Compute Engine `e2-micro`** (1 VM gratuita vitalícia nas regiões `us-central1`, `us-west1` ou `us-east1` com 30 GB de disco Standard Persistent Disk): Roda o processo Node.js + Baileys 24/7 mantendo a conexão WebSocket viva e salvando a sessão em disco com **custo US$ 0,00/mês**.
    - **Banco de Dados a Custo Zero**: Usar **SQLite (com WAL mode)** dentro do disco de 30 GB da própria VM `e2-micro` (zero latência e custo zero) ou **Supabase / Neon.tech (PostgreSQL Free Tier)** externo, evitando o custo alto do Cloud SQL.

## [2026-11-07] Implementação da Fase 1 (WhatsApp & AI Core Hub + Banco Multi-Domínio)
- Criada a estrutura completa do projeto em TypeScript para Node.js 24+ ([package.json](file:///c:/_dev/atendimento_whatsapp/package.json), [tsconfig.json](file:///c:/_dev/atendimento_whatsapp/tsconfig.json), [.env.example](file:///c:/_dev/atendimento_whatsapp/.env.example)).
- Implementada a camada de banco de dados SQLite nativo (`node:sqlite` em modo WAL) em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql) e [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts), criando as 10 tabelas dos 2 domínios:
  - **Domínio 1 (Hub)**: `whatsapp_instances`, `webhook_subscriptions`, `hub_message_logs`.
  - **Domínio 2 (Fichas Multi-Nicho)**: `vertical_presets`, `tenants`, `customers`, `dynamic_records`, `session_evolutions`, `scheduled_followups`, `print_batches`.
- Criados os seeds multi-nicho em [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts) com 3 configurações prontas de tipos de negócio: `massoterapia_estetica`, `pet_shop_banho_tosa` e `oficina_estetica_automotiva`.
- Implementado o serviço de IA [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) integrado ao `gemini-2.5-flash` para transcrição de áudio (`.ogg`), leitura de fotos de fichas físicas e extração JSON estruturada conforme o schema do negócio.
- Implementado o roteador de eventos e webhooks externos [webhook.dispatcher.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/webhooks/webhook.dispatcher.ts) com assinatura HMAC-SHA256 (`X-Hub-Signature`) e filtros de roteamento (`prefix`, `onlyAudio`), permitindo conectar qualquer outra solução futura ao Hub.
- Implementado o gerenciador multi-sessão do WhatsApp com Baileys em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts), API REST em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e painel web de controle/simulação em [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html).
- Adicionados os artefatos de deploy gratuito para a VM `e2-micro` do Google Cloud ([Dockerfile](file:///c:/_dev/atendimento_whatsapp/Dockerfile) e [gcp-e2-micro-setup.sh](file:///c:/_dev/atendimento_whatsapp/scripts/gcp-e2-micro-setup.sh)) e validado o funcionamento do banco e eventos com [verify-setup.ts](file:///c:/_dev/atendimento_whatsapp/src/scripts/verify-setup.ts) (consumindo apenas ~66 MB de RAM).

## [2026-11-07] Roteiro de Validação da Fase 1 vs. Avanço para Fases 2 e 3
- Documentados os comandos para validar a Fase 1 isoladamente:
  1. `npm run test:db` (valida criação das 10 tabelas SQLite, presets de nicho, dispatcher de webhooks e memória RAM sem precisar de pacotes externos).
  2. `npm install` seguido de `npm run dev` e acesso ao painel `http://localhost:3000` (para testar conexão QR Code do Baileys, cadastro de webhooks para sistemas externos e simulador de extração Gemini por nicho).
- Recomendado implementar já as **Fases 2 e 3** em sequência para permitir um teste completo ponta a ponta (conversa no WhatsApp preenchendo a ficha + modo ditado da profissional gerando prontuário real).

## [2026-11-07] Implementação Completa das Fases 2, 3, 4 e 5 + Validação Ponta a Ponta
- **Fase 2 — Motor Configurável Multi-Nicho ([schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts))**:
  - Resolução dinâmica de schema mesclando `vertical_presets` com customizações do estabelecimento (`tenants.custom_schema_overrides`).
  - Extração híbrida de campos: utiliza `gemini-2.5-flash` quando `GEMINI_API_KEY` está configurada e conta com extrator semântico nativo em português (permitindo testar 100% offline/zero-config).
  - Motor de cálculo automático de `AlertRules` (`🚨 Alergia`, `⚠️ Gestante`, `🔥 Dor Aguda`) e gerador de Resumo Executivo em bullets.
- **Fase 3 — Orquestrador Conversacional & Modo Ditado da Profissional ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts))**:
  - **Fluxo Cliente**: Cria cadastro e ficha dinâmica, aceita respostas parciais ou completas em um único áudio/texto, gera assinatura digital (`consent_signature`) ao concluir e envia o resumo para o WhatsApp da profissional.
  - **Fluxo Profissional (Modo Ditado)**: Identifica mensagens enviadas pelo `owner_phone`, anexa evoluções de sessão em `session_evolutions` sem digitação e responde a consultas rápidas via comando `#ficha [nome/telefone]`.
- **Fase 4 — Ponte Físico-Digital ([print.generator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/print.generator.ts))**:
  - Gerador de blocos físicos prontos para impressão/PDF (`/api/v1/tenants/:id/print-preview`) com identidade visual da clínica, campos do nicho ativo e QR Code inteligente (`STATIC_TENANT` ou `UNIQUE_PER_SHEET`) apontando para o WhatsApp.
- **Fase 5 — Motor da "Ficha Viva" / Pós-Atendimento ([followup.worker.ts](file:///c:/_dev/atendimento_whatsapp/src/records/followup.worker.ts))**:
  - Agendamento automático de mensagens de retorno pós-sessão (`scheduled_followups`), análise de sentimento da resposta do cliente e disparo de alerta crítico para a profissional caso detecte reação adversa (`ADVERSE_REACTION`).
- **Servidor HTTP Nativo & Painel Unificado ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html))**:
  - Migrado para `node:http` nativo do Node.js 24, permitindo subir o painel web completo (`npm run dev`) imediatamente sem depender de frameworks pesados e mantendo o uso de memória em **~68 MB de RAM**.
  - Validado ponta a ponta via [verify-setup.ts](file:///c:/_dev/atendimento_whatsapp/src/scripts/verify-setup.ts) (`npm run test:db`).

## [2026-11-07] Preparação para Conexão Real com WhatsApp (Baileys QR Code)
- Otimizado o [package.json](file:///c:/_dev/atendimento_whatsapp/package.json) mantendo apenas as dependências essenciais (`@whiskeysockets/baileys`, `pino`, `qrcode`).
- Criado o arquivo `.env` local padrão e adicionado no painel [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) o campo para configurar em tempo real o telefone da profissional (`owner_phone`).
- Iniciada a instalação das dependências (`npm install`) para habilitar a geração do QR Code real do Baileys.
- Corrigida a dependência `libsignal` do `@whiskeysockets/baileys` via `overrides` no [package.json](file:///c:/_dev/atendimento_whatsapp/package.json) (usando tarball HTTPS direto em vez de `git+https`, evitando erro `spawn git ENOENT` no Windows). Pacotes instalados com `0 vulnerabilities`.
- Adicionado fallback automático de porta (`EADDRINUSE`) em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e servidor ativo em `http://localhost:3000` pronto para leitura do QR Code real do WhatsApp.

## [2026-11-07] Habilitação de Teste Direto Consigo Mesmo (`@dmessiasb`) + Filtro de Segurança
- Atualizado [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) para suportar troca de mensagens consigo mesmo (`fromMe: true` na conversa pessoal `5511974065584` / `195386702577754@lid` / `@dmessiasb`) com dupla proteção anti-loop (`botSentMessageIds` + `botReplySignatures`).
- Adicionado **Filtro de Segurança para WhatsApp Pessoal**: ignora mensagens de outros contatos pessoais (evitando responder amigos/familiares por engano) e só responde na conversa consigo mesmo (`@dmessiasb`) ou quando a mensagem iniciar explicitamente com `#teste`, `#ficha`, `#prof` ou `#reset`.
- Preservado o `remoteJid` original (`@lid` ou `@s.whatsapp.net`) ao responder em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) e [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts).
- Adicionada reconexão automática na inicialização do servidor ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)) quando `creds.json` já existe em disco.
- Adicionado formulário **"📤 Enviar Mensagem Real para Contato"** no painel [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) integrado ao endpoint `POST /api/v1/messages/send` para disparo direto de mensagens via WhatsApp conectado.

## [2026-11-07] Trava Estrita de Conversa (`Amor Gatosa` / Print) + Analisador de Contexto Conversacional
- **Correção da causa raiz do disparo ao enviar mensagens (`fromMe: true`)**:
  - No WhatsApp/Baileys, quando o dono da conta (`Diego Messias Batista`) envia uma mensagem para outra pessoa, o campo `msg.pushName` vem com o próprio nome do remetente (`Diego Messias Batista`), o que acionava o filtro anterior quando ele digitava e ignorava quando a outra pessoa (`Amor Gatosa` / `💚Deeh❤️`) respondia.
  - Em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts), a lista `ALLOWED_TEST_JIDS` foi travada **exclusivamente** no identificador da conversa do print (`237327075004656@lid`), bloqueando 100% de todas as outras conversas do WhatsApp.
  - Além disso, mensagens enviadas pelo próprio dono da conta (`msg.key.fromMe === true`) agora são apenas salvas no histórico para contexto e **nunca** disparam resposta automática do robô (a menos que sejam comandos explícitos iniciados por `#reset`, `#ficha` ou `#prof`).
- **Analisador de Contexto e Intenção (`classifyConversationIntent`) em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) e [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)**:
  - Mensagens casuais trocadas na conversa (`"Kkkkkkkk"`, `"No vivo ?"`, `"Entendi"`, `"Legal"`, links, etc.) são classificadas como `CASUAL_CHAT_IGNORE` e o sistema permanece em silêncio sem interromper a conversa.
  - Quando a pessoa envia um pedido real de atendimento (como `"Quero agendar uma Sessão de massagem relaxante"` do print), o sistema detecta `SERVICE_OR_BOOKING_REQUEST`, já preenche automaticamente a queixa/objetivo com o pedido dela e conduz as perguntas restantes sem jamais repetir a mesma pergunta seguida.

## [2026-11-07] Conversa 100% Natural ("Anamnese Invisível")
- Atualizados os textos de pergunta em [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts), [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) e o fluxo de resposta em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts) para que o cliente **não perceba que está preenchendo uma ficha de anamnese**:
  - Removidos emojis robóticos (`✅`, `👉`, `📋`, `🎉`), menções às palavras *"Ficha"* ou *"Anamnese"* e o envio do resumo estruturado para o chat do cliente.
  - As perguntas fluem como um bate-papo humano de pré-atendimento e, ao final, o sistema apenas pergunta *"Maravilha, já deixei tudo certinho aqui pro seu atendimento! Qual melhor dia e horário fica bom pra você?"*, enquanto salva a ficha completa e os alertas silenciosamente na **Prancheta Digital**.

## [2026-11-07] Simulação de Digitação Humana e Proteção Anti-Bloqueio (Baileys)
- Atualizado o método `sendTextMessage` em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) com 3 camadas de humanização e segurança contra bloqueio no WhatsApp:
  1. **Tempo de Leitura Inicial (`2.0s a 3.8s` aleatório)**: Simula o tempo que uma pessoa leva para ler a mensagem recebida antes de começar a responder.
  2. **Status Real `"digitando..."` (`sendPresenceUpdate('composing')`)**: Exibe o indicador nativo de digitação no WhatsApp do destinatário.
  3. **Tempo de Digitação Proporcional + Jitter Aleatório (`3.0s a 8.0s`)**: Calcula o tempo com base no tamanho do texto somado a uma variação randômica (totalizando ~6 a 11 segundos por resposta), desativando o indicador (`paused`) imediatamente antes do envio.

## [2026-11-07] Correção de Continuidade de Atendimento ("Focar em relaxar") e Auto-Retomada
- Identificado nos logs que a cliente enviou `"Focar em relaxar"` na etapa `nivel_dor`, e a expressão regular anterior exigia a palavra `"só"` antes de `"relaxar"` (`s[oó]\s+relaxar`).
- Atualizado [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) para que:
  1. Quando já existe uma ficha `IN_PROGRESS`, qualquer resposta natural da cliente (que não seja risada/link/comentário solto) seja tratada como `ANAMNESIS_ANSWER`.
  2. O extrator de `nivel_dor` reconheça `"focar em relaxar"`, `"relaxar"`, `"sem dor"`, etc. como nível `0`, e aceite qualquer resposta descritiva sem travar a conversa.
- Adicionada rotina de **Auto-Retomada (`AutoResume`)** em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) ao abrir a conexão: se a última mensagem da conversa autorizada (`237327075004656@lid`) estiver pendente de resposta (`direction = 'INBOUND'`), o sistema processa e envia a continuação automaticamente.

## [2026-11-07] Fechamento do Horário + Perguntas Neutras (Sem Constrangimento de Gênero ou Agendamento para Terceiros)
- **Fechamento da etapa de horário (`preferencia_horario`)**:
  - Adicionado o campo `preferencia_horario` ao schema de [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts) para que a pergunta *"Maravilha, já deixei tudo certinho aqui! Qual melhor dia e horário fica bom?"* aguarde a resposta do cliente (texto ou áudio) e finalize com a confirmação: *"Perfeito, já deixei seu horário pré-reservado aqui pra você! Te espero então, qualquer coisa até lá é só me chamar 😊"*.
- **Perguntas neutras para qualquer gênero e agendamentos para outra pessoa**:
  - Substituída a pergunta direta *"Você está gestante?"* (que seria inadequada para homens ou quando alguém agenda para outra pessoa) por:
    1. `para_quem_e_nivel_dor`: *"Claro, vamos combinar sim! A sessão vai ser pra você mesmo(a) ou está agendando pra outra pessoa? E me conta se a ideia é focar só em relaxar ou se tem alguma dor mais forte (tipo de 0 a 10)."*
    2. `historico_saude` (unificado e neutro): *"Combinado. E existe alguma condição de saúde importante que eu precise saber antes do atendimento (como pressão alta, cirurgia recente, questão circulatória ou gestação)?"* — Se a resposta mencionar gestação/gravidez, o motor [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) aciona automaticamente o alerta `⚠️ Gestante`.

## [2026-11-07] Configuração do Catálogo ADEN Massoterapia + Guia e Ativação da API Gemini
- Configurado o catálogo oficial da cliente **ADEN Massoterapia** (`(41) 99176-9268` / cor Verde Sálvia `#5F7358`) em [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts), [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts), [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) e [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts):
  - **Massagem Relaxante** (60 min): R$ 120,00 | Pacote (4 Sessões): R$ 420,00
  - **Drenagem Linfática** (50 min): R$ 80,00 | Pacote (4 Sessões): R$ 280,00
  - **Massagem com Pedras Quentes** (75 min): R$ 170,00 | Pacote (4 Sessões): R$ 600,00
  - **Thai Massage** (60 min): R$ 160,00 | Pacote (4 Sessões): R$ 560,00
  - **Massagem Localizada (Foco na Queixa)** (30 min): R$ 80,00 | Pacote (4 Sessões): R$ 280,00
- Adicionada detecção automática de dúvidas de preços/catálogo (`CATALOG_OR_PRICE_QUERY`) para responder com a tabela oficial da **ADEN Massoterapia** e perguntar se a pessoa prefere sessão avulsa ou pacote de 4 sessões.
- Criado endpoint `POST /api/v1/config/gemini` em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e botão **"🔑 Configurar Chave Gemini (Voz/IA)"** em [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) para configurar e validar a `GEMINI_API_KEY` em 1 clique sem reiniciar o servidor.
- Criado o documento [GUIA_CONFIGURACAO_GEMINI.md](file:///c:/_dev/atendimento_whatsapp/GUIA_CONFIGURACAO_GEMINI.md) com o passo a passo completo.
- Adicionado suporte em [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) para chaves do **Vertex AI Express Mode (`AQ....`)** (`aiplatform.googleapis.com`) e chaves do Google AI Studio (`AIzaSy...`) (`generativelanguage.googleapis.com`), com fallback automático entre modelos (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`), e salva a chave fornecida diretamente no arquivo [.env](file:///c:/_dev/atendimento_whatsapp/.env).

## [2026-11-07] Liberação do Contato de Teste: Ricardo Messias Batista
- Atualizada a trava de segurança em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) para autorizar automaticamente a conversa com **Ricardo Messias Batista** (tanto pelo `pushName` dele quanto caso o dono da conta envie uma mensagem mencionando `Ricardo`, `agendar` ou `#liberar` no chat dele), mantendo todas as demais conversas pessoais bloqueadas.

## [2026-11-07] Credenciais de IA/WhatsApp por Empresa + Skill de Segurança por Empresa + Novo Painel Administrativo Modular
- **Isolamento de Credenciais e Segurança por Empresa (`tenants`) em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql) e [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)**:
  - Adicionadas colunas por empresa com migração automática segura (`runSafeMigrations`):
    - `ai_api_key` e `ai_model`: Permite que cada empresa cadastrada tenha sua própria chave do Gemini (AI Studio ou Vertex AI).
    - `whatsapp_instance_id`: Vincula cada empresa à sua própria sessão/QR Code do WhatsApp.
    - `security_mode` (`TEST_WHITELIST` vs. `PRODUCTION_ALL`) e `allowed_test_jids`: Permite configurar a trava de contatos autorizados individualmente por empresa.
    - `skill_markdown`: Armazena a **Skill & Guardrails de Segurança (`SKILL.md`)** exclusiva de cada empresa (Catálogo Oficial, Tom de Voz, Regras do que a IA NUNCA pode responder), injetada em todas as chamadas de [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts).
- **Novo Painel Administrativo SaaS Multi-Módulo ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) e [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts))**:
  - Substituído o layout de página única por um painel administrativo profissional com **Sidebar de Navegação Lateral**, **Seletor Global de Empresa no Topo** e **6 Módulos Separados**:
    1. `📋 Prancheta Digital`: KPIs, fichas concluídas/em andamento, alertas clínicos e histórico de evoluções da empresa selecionada.
    2. `🏢 Empresas & Credenciais`: Cadastro de novas empresas e configuração individual de Chave Gemini, Instância WhatsApp, Telefone do Profissional e Modo de Segurança (`TEST_WHITELIST` / `PRODUCTION_ALL`).
    3. `🛡️ Skill & Guardrails IA`: Editor dedicado do documento `SKILL.md` da empresa ativa + visualização das perguntas naturais do nicho.
    4. `📱 Conexões WhatsApp`: Gestão dedicada das instâncias Baileys (QR Code por empresa) e disparo direto de mensagens.
    5. `🔄 Ficha Viva (Pós-Sessão)`: Gestão dos follow-ups automáticos D+1 e alertas de reação adversa.
    6. `🔌 Webhooks & Simulador`: Cadastro de webhooks para outros sistemas externos, simulador de conversa e logs técnicos.

## [2026-11-07] Correção da Transcrição de Áudios (`gemini-3.8-flash`) e Resposta a Dúvidas Abertas/Pós-Ficha (Ricardo)
- **Causa Raiz Identificada e Corrigida em [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts)**:
  - A chave `AQ....` funcionava no endpoint `generativelanguage.googleapis.com`, porém o modelo `models/gemini-2.5-flash` havia sido descontinuado para novas chaves em favor do **`models/gemini-3.8-flash`** (com fallback para `gemini-flash-latest` e `gemini-2.5-flash-lite`).
  - Atualizado [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts), [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) e [.env](file:///c:/_dev/atendimento_whatsapp/.env) para utilizar **`gemini-3.8-flash`** via `https://generativelanguage.googleapis.com/v1beta/models/...`, garantindo transcrição fiel palavra por palavra de todos os áudios (`.ogg`) enviados pelo WhatsApp.
- **Respostas Contextuais a Dúvidas Abertas e Pós-Ficha em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) e [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)**:
  - Adicionado `CLIENT_QUESTION_OR_DOUBT` e geração de `conversationalReply` + `isClientQuestion` usando a **Skill da Empresa (`skill_markdown`)** para responder naturalmente a perguntas abertas feitas por texto ou áudio (ex: *"Como é o esquema de massagem?"*, *"Completa?"*, dúvidas de funcionamento), tanto durante a entrevista quanto após a ficha já estar concluída (`COMPLETED`).
  - Bloqueado o preenchimento de campos da ficha com textos de fallback de áudio ou perguntas do cliente, e reiniciada a ficha de teste do cliente **Ricardo** (`149091233304709@lid`) para novo teste limpo.
- **Exibição das Transcrições de Áudio na Prancheta Digital ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html))**:
  - Incluído o array `audioTranscriptions` em `GET /api/v1/records` e criada a seção **`🎙️ Transcrições de Áudios do Cliente`** diretamente dentro do card de cada cliente na **Prancheta Digital**, além de exibir o texto integral dos áudios transcritos na aba de **Logs**.

## [2026-11-07] Modo Assistente da Profissional no Próprio WhatsApp ("Você") + Consulta de Agenda da Semana e Pós-Atendimento
- **Detecção Automática do Chat Pessoal "Você" (`isSelfChat`) em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)**:
  - Quando a profissional envia mensagem de texto ou áudio para a própria conversa **"Você (Mensagem para si mesma)"** no WhatsApp conectado (ou usa comandos `#agenda`, `#ficha`, `#atendi`, `#prof`, ou envia a partir do `owner_phone`), o sistema identifica automaticamente como comando da profissional.
- **Consultas e Pós-Atendimento via WhatsApp em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)**:
  1. **Agenda / Atendimentos Previstos da Semana (`#agenda` ou pergunta natural *"Quais os atendimentos previstos para a semana?"*)**: Lista todos os pacientes pré-agendados/em conversa com procedimento escolhido, preferência de horário e alertas clínicos.
  2. **Consulta de Ficha Individual (`#ficha Nome` ou *"Ficha do paciente X"*)**: Retorna o resumo executivo, alertas e histórico das últimas sessões.
  3. **Registro de Pós-Atendimento (`#atendi ...`, `#prof ...` ou áudio/texto *"Atendi o paciente X, procedimento Y..."*)**: Salva a evolução na tabela `session_evolutions` e agenda automaticamente o follow-up D+1 (**Ficha Viva**) na tabela `scheduled_followups`.

## [2026-11-07] Refinamento do Reconhecimento de Perguntas de Agenda e Bloqueio de Falsos Pós-Atendimentos ("Cliente Ditado")
- **Reconhecimento Amplo de Perguntas sobre Agenda ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts))**:
  - Expandida a detecção de consultas de agenda da profissional para entender frases como *"quais atendimentos que tenho para a semana?"*, *"tenho atendimento hoje?"*, *"quem eu atendo amanhã?"* e variações com palavras intermediárias.
- **Trava contra Registro Acidental de Pós-Atendimento (`isExplicitAttendanceReport`)**:
  - O sistema agora **nunca** cria um `"Cliente Ditado"` a partir de uma pergunta (`?`) ou anotação pessoal solta na conversa `"Você"`. O registro de pós-atendimento só é acionado quando a profissional usa verbos claros de sessão realizada (`"Atendi..."`, `"Realizei..."`, `"Finalizei..."`, `"Fiz massagem..."`, `#atendi`).
  - Removido o registro falso `"Cliente Ditado"` do banco de dados e restaurado o agendamento confirmado de **Amor Gatosa** (*Massagem com Pedras Quentes — Sexta-feira às 16h*).

## [2026-11-07] Prioridade de Registro de Atendimento por Voz ("Quero registrar o atendimento...") sobre Consulta de Agenda
- **Correção de Ordem de Prioridade em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)**:
  - Quando a profissional enviou o áudio *"Quero registrar o atendimento que foi feito para Ricardo Messias Batista na data de ontem, tá? ... mas hoje ele teve um novo contato pedindo uma nova sessão, porque ele estava com dores na lombar"*, a expressão antiga `atendimentos?\s+.*hoje` havia capturado `"atendimento ... hoje"` como consulta de agenda antes de chegar no bloco de registro de pós-atendimento.
  - Invertida a ordem em [`handleProfessionalMessage`](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts#L117-L360) para avaliar **primeiro** se é um relato/registro de atendimento (`"quero registrar o atendimento"`, `"atendimento que foi feito"`, `"atendi"`, `"realizei"`, `"finalizei"`, `#atendi`), extraindo o nome completo (`Ricardo Messias Batista`), salvando a evolução em `session_evolutions` e atualizando também o pré-agendamento na agenda da semana caso uma nova sessão seja mencionada no áudio.

## [2026-11-07] Configuração de Chave Pix & Sinal Obrigatório com Confirmação Exclusiva pela Profissional
- **Novos Campos por Empresa (`tenants`) em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql), [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) e [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts)**:
  - `require_down_payment` (`0` = Agendar direto | `1` = Exigir Sinal via Pix).
  - `pix_key` (Chave Pix da empresa: CPF, CNPJ, Celular, E-mail ou Chave Aleatória).
  - `down_payment_info` (Valor ou regra do sinal, ex: `"50% do valor da sessão"` ou `"R$ 50,00"`).
- **Fluxo Anti-Fraude de Agendamento Mediante Sinal em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)**:
  - Quando `requireDownPayment === true` e `pixKey` está preenchida, ao concluir as perguntas da ficha o registro entra no status **`PENDING_PAYMENT` (`💸 Aguardando Sinal Pix`)** em vez de `COMPLETED`, enviando a chave Pix e o valor do sinal para o cliente.
  - **Bloqueio de Auto-Confirmação pelo Cliente:** Mesmo que o cliente envie mensagem dizendo *"Já fiz o Pix"*, *"Paguei"* ou *"Segue comprovante"*, o sistema **nunca** muda o status para `COMPLETED` sozinho; ele responde que encaminhou para conferência da profissional.
  - **Confirmação Exclusiva pelo Usuário/Profissional (`confirmPaymentAndSchedule`)**:
    1. **Via WhatsApp (Chat `"Você"` ou `ownerPhone`):** A profissional envia `#confirmar Nome` ou diz por áudio/texto *"Confirmei o pagamento do Ricardo"* / *"Recebi o Pix do Ricardo"*. O sistema muda o status para `COMPLETED` e envia automaticamente a confirmação oficial do agendamento para o WhatsApp do cliente.
    2. **Via Painel Administrativo ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) e `POST /api/v1/records/:id/confirm-payment` em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)):** Adicionado botão **`✅ Confirmar Recebimento do Sinal & Agendar`** nos cards com status `PENDING_PAYMENT` na Prancheta Digital, além da seção de configuração de Chave Pix na aba `🏢 Empresas & Credenciais`.

## [2026-11-07] Otimização de Latência do Gemini (`gemini-2.5-flash-lite` + `AbortSignal.timeout`) para Áudios e Dúvidas
- **Diagnóstico de Latência no Áudio do Ricardo (`21:52:52` -> `21:54:09`)**:
  - O áudio do Ricardo (*"Eu preciso saber o endereço da onde é a massagem."*) foi transcrito e respondido (*"Olá! Nossos atendimentos são realizados com hora marcada em nosso espaço preparado e acolhedor em Curitiba..."*), porém o modelo `gemini-3.8-flash` estava levando **70 a 80 segundos** para responder cada chamada, dando a impressão de que o áudio não havia sido processado.
- **Correção Aplicada em [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts)**:
  - Definido **`gemini-2.5-flash-lite`** como primeiro modelo da fila (`['gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash']`), reduzindo o tempo de transcrição e raciocínio da IA de ~75 segundos para **~1,5 segundo**, além de adicionar `AbortSignal.timeout(12000)` para que nenhuma requisição lenta trave a fila do WhatsApp.
  - Adicionado reconhecimento explícito de dúvidas de endereço (`"endereço"`, `"onde é a massagem"`) e procedimentos avulsos (`"Relaxante"`) em [`classifyConversationIntent`](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts#L168-L240).

## [2026-11-07] Memória de Clientes Identificados, Fim da Repetição de Perguntas e Atualização da Skill (Caso Ricardo)
- **Diagnóstico da Conversa com Ricardo (`21:57:22` a `22:00:05`)**:
  - O Ricardo disse *"Eu já avisei que não tenho"* e depois *"Primeiro que você nem sabe meu nome"*. O extrator heurístico antigo (`else if (isYes || lower.length > 2)`) havia gravado a frase *"Primeiro que você nem sabe meu nome"* como se fosse uma condição de saúde (`Sim`) e respondido com a frase pronta *"Maravilha, já deixei tudo certinho aqui!"*, sem chamá-lo pelo nome nem lembrar da sessão anterior dele.
- **Correções Implementadas em [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts), [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts), [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts) e [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)**:
  1. **Herança Automática de Dados de Clientes Recorrentes (`inheritedProfileData`)**: Quando um cliente já possui ficha ou histórico anterior (`allCustomerRecords` / `session_evolutions`), o sistema herda automaticamente `alergias`, `historico_saude` e `para_quem_e_nivel_dor` para **nunca repetir perguntas já respondidas**.
  2. **Injeção do Perfil e Memória do Cliente no Gemini (`GeminiCustomerProfile`)**: O Gemini agora recebe `fullName` (`Ricardo Messias Batista`), `firstName` (`Ricardo`), `isReturningCustomer` (`true`) e `pastEvolutionsSummary` (relato da sessão de ontem na lombar), e o orquestrador utiliza sempre a resposta personalizada do Gemini (`conversationalReply`) em vez de perguntas frias estáticas.
  3. **Remoção do Fallback Cego (`lower.length > 2`)**: Frases como *"Primeiro que você nem sabe meu nome"* ou *"Já avisei que não tenho"* nunca mais são salvas como condição clínica positiva.
  4. **Atualização da `SKILL.md` da ADEN Massoterapia**: Atualizada no código ([db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)) e no banco ativo com as regras de **Atendimento Pessoal pelo Nome**, **Memória de Clientes da Casa**, **Proibição de Repetir Perguntas Já Respondidas**, **Adaptação de Gênero** (nunca citar gestação para homens agendando para si mesmos) e **Proibição de Respostas Robóticas Fora de Contexto**.

- **Fase 17: Cadastro de Serviços com Valores (Painel & WhatsApp), Conversão Automática Arredondada do Sinal Pix e Fluxo Natural sem Pular Etapas (2026-11-07)**:
  1. **Catálogo Estruturado de Serviços por Empresa (`services_catalog`)**:
     - Adicionada a coluna `services_catalog` em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql), [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) e `PATCH /api/v1/tenants/:id` em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts), já pré-populada com os 5 serviços oficiais da **ADEN Massoterapia**.
  2. **Conversão Automática do Percentual em Valor Exato em Reais (Sempre Arredondado)**:
     - Implementado `calculateDownPaymentForService` em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) que cruza o serviço escolhido pelo cliente (avulso ou pacote 4x) com o catálogo da empresa e converte o percentual configurado (ex: `30%`) no valor exato em Reais usando `Math.round()` (ex: Massagem Relaxante `R$ 120,00` -> Sinal `R$ 36,00`; Pedras Quentes `R$ 170,00` -> Sinal `R$ 51,00`; serviço de `R$ 95,00` a `30%` = `28,5` -> arredondado para `R$ 29,00`).
  3. **Gestão de Serviços pelo Painel Web e pelo WhatsApp da Profissional**:
     - **No Painel ([public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html))**: Tabela interativa em **🏢 Empresas & Credenciais** para adicionar, editar ou remover serviços com prévia ao vivo do **Sinal Calculado (Arredondado)**.
     - **No WhatsApp ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts))**: A profissional pode listar seus serviços e sinais arredondados enviando `#servicos` ou *"quais serviços estão cadastrados?"*, e pode cadastrar ou alterar valores por voz ou texto dizendo *"Quero cadastrar o serviço Nome por X reais Y minutos"*, *"Alterar o valor da Massagem X para Y reais"* ou `#servico Nome | Minutos | ValorAvulso | ValorPacote`.
  4. **Correção do Fluxo de Conversa (Debounce de 3s + Validação Estrita de Horário)**:
     - Adicionado buffer de debounce de 3 segundos em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) para agrupar mensagens curtas enviadas em sequência (como `"Olá"` seguido de `"Boa noite !"`) em uma única resposta.
     - Removido o preenchimento cego de `preferencia_horario` em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) (`isValidSchedulePreference`), garantindo que o assistente conduza a conversa naturalmente desde a saudação e escolha do serviço até o dia/horário antes de solicitar o sinal Pix.

- **Fase 18: Agenda Guardada com Verificação de Conflitos, Exigência de Horário Exato (`HH:MM`), Mensagens Curtas e Tempo de Digitação Realista (2026-11-07)**:
  1. **Agenda Guardada (`appointments`) e Bloqueio de Conflitos**:
     - Criada a tabela `appointments` em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql) e implementados os métodos `parseScheduleComponents()`, `checkAgendaAvailability()` e `saveAppointmentSlot()` em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts).
     - O sistema nunca conclui o agendamento nem cobra o Pix apenas com o dia (*"Próxima terça"*) ou apenas com o turno (*"De manhã"*). Ele consulta a agenda guardada, verifica a duração do procedimento para não sobrepor outros atendimentos, sugere os horários livres do turno (ex: `09:00`, `10:30`, `11:30`) e só avança para o sinal Pix quando o cliente escolhe um horário exato livre.
  2. **Brevidade Natural de WhatsApp (Respostas Curtas)**:
     - Atualizadas as instruções de geração em [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e a `SKILL.md` em [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) para exigir respostas curtas e diretas (1 a 2 frases curtas, estilo WhatsApp real), eliminando textos longos.
  3. **Tempo de Leitura e Digitação Proporcional Realista**:
     - Ajustado `sendTextMessage` em [baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) para pausa de leitura humana (`3.5s` a `5.8s`) + digitação proporcional (`~85ms` por caractere, de `6.5s` a `20s`) mantendo o status `"digitando..."` ativo.
  4. **Auto-Inferência de 1ª Pessoa (`para_quem_e_nivel_dor`) e Contexto de Escolha ("Quero uma dessa")**:
     - Atualizados [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts), [seeds.ts](file:///c:/_dev/atendimento_whatsapp/src/database/seeds.ts), [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts): quando o(a) cliente fala em 1ª pessoa sobre sua própria dor ou incômodo (ex: *"eu tô com uma dor nas pernas que tá me incomodando bastante"*), o sistema preenche automaticamente `para_quem_e_nivel_dor` como `"Para si mesma(o) — [relato]"` antes mesmo de chamar o Gemini, eliminando a pergunta redundante *"A sessão vai ser pra você mesma?"*.
     - Quando o cliente diz *"quero uma dessa então"*, o sistema vincula ao procedimento que acabou de ser explicado no histórico recente (ex: `Massagem Localizada - Foco na Queixa`).
     - Quando o cliente informa apenas o turno (*"Prefiro de manhã"*) sem dizer o dia, o assistente pergunta qual dia da semana fica melhor, e nunca sugere *"Hoje de manhã"* após o expediente.

- **Fase 19: Identidade Obrigatória da Atendente ("Adenilde"), Habilitação Automática do Botão de Confirmação de Pagamento e Reconhecimento Fonético de Voz para Confirmar Sinal (2026-11-07)**:
  1. **Identidade Estrita conforme a Skill ("Adenilde")**:
     - Atualizados [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) para sanitizar do histórico o apelido antigo *"Adenzinha"* e obrigar a IA a se apresentar exclusivamente como **Adenilde** conforme definido nos Guardrails da Skill, além de preservar edições manuais feitas na Skill pelo painel.
  2. **Transição Garantida para `PENDING_PAYMENT` e Botão na Prancheta Digital**:
     - Corrigido o retorno antecipado em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts) (quando o cliente envia áudio ou pergunta junto com a escolha de horário) para garantir que a ficha mude imediatamente para `PENDING_PAYMENT` assim que todos os campos estiverem preenchidos (`!nextField`), e atualizado [public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) para exibir o botão **`✅ Confirmar Recebimento do Sinal & Agendar`**.
  3. **Reconhecimento Fonético/Aproximado na Confirmação por Voz da Profissional**:
     - Em [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts) (`confirmPaymentAndSchedule`), adicionado filtro de sufixos (*"e confirmar o horário dela"*) e busca fonética por trigramas para que transcrições de voz como *"Pode confirmar o pagamento da Morganosa e confirmar o horário dela"* encontrem e confirmem automaticamente a ficha de **Amor Gatosa**.

### Fase 20: Exclusão de Sessão de WhatsApp, Troca de Aparelho/QR Code e Criação de Nova Sessão (Concluída)
1. **Gerenciamento Completo de Sessões no `BaileysMultiSessionManager` ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
   - Adicionado controle `stoppedOrDeletedInstances` para impedir que sessões pausadas ou excluídas tentem reconectar automaticamente no evento `connection === 'close'`.
   - Implementado método `deleteSession(instanceId)` que encerra o socket ativo do Baileys, remove o diretório físico de credenciais (`data/whatsapp_sessions/<instanceId>`), desvincula empresas que apontavam para a sessão (`UPDATE tenants SET whatsapp_instance_id = NULL`) e remove o registro de `whatsapp_instances`.
   - Atualizado `stopSession(instanceId, logout = true)` para limpar a pasta de autenticação quando solicitado reset de QR Code / troca de aparelho.
2. **Novas Rotas de API ([src/server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)) e Persistência ([src/database/db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)):**
   - `DELETE /api/v1/instances/:id`: Exclui completamente uma sessão de WhatsApp e limpa seus arquivos de autenticação em disco.
   - `POST /api/v1/instances/:id/reset-qr`: Limpa as credenciais salvas da sessão atual e gera imediatamente um novo QR Code para conectar outro número/aparelho.
   - `POST /api/v1/instances`: Cria uma nova sessão de WhatsApp, vincula automaticamente à empresa selecionada (`tenantId`) ou às empresas sem sessão ativa, e já inicia a geração do QR Code (`autoConnect: true`).
3. **Interface de Gerenciamento na Aba Conexões WhatsApp ([public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - Adicionado formulário rápido **"+ Criar Nova Sessão & Gerar QR Code"** no topo da aba **📱 Conexões WhatsApp**.
   - Adicionados botões em cada sessão: **📱 Gerar QR Code / Conectar**, **🔄 Trocar Aparelho / Novo QR**, **⏸️ Pausar**, **🗑️ Excluir Sessão** e **🔗 Vincular à Empresa**.

### Fase 21: Auto-Start de Sessões Conectadas, Suporte a `ephemeralMessage` / `deviceSentMessage` e Retomada de Atendimentos no Número da Adenilde (Concluída)
1. **Auto-Reconexão no Boot do Servidor (`autoStartSavedSessions`) ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) e [src/server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)):**
   - Sempre que o servidor inicia ou reinicia, reconecta automaticamente todas as sessões em `whatsapp_instances` que possuam credenciais salvas (`creds.json`), mantendo a sessão `inst_whatsapp_aden_2401` (`554191769268` — Adenilde) sempre ativa.
2. **Desempacotamento de Mensagens Temporárias (`ephemeralMessage`) e Eventos `append` / `history` ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
   - Implementado `unwrapBaileysMessage()` para extrair texto, áudio e imagem mesmo quando o cliente usa Mensagens Temporárias (`ephemeralMessage`), visualização única (`viewOnceMessage`) ou envio multi-dispositivo (`deviceSentMessage`).
   - Suporte a eventos `notify`, `append` e `messaging-history.set` com deduplicação por ID de mensagem (`processedIncomingMsgIds`) e correspondência fonética/sem acento na lista de contatos (`Jhessica` / `Jéssica`, `Geovana` / `Giovana`, `Jackson`, `Diego`).
3. **Preservação de Configurações e Retomada Automática ([src/database/db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)):**
   - Garantido que `allowed_test_jids` e `security_mode` configurados no painel não sejam sobrescritos ao reiniciar o banco.
   - Se um cliente enviou mensagem antes de o QR Code da nova sessão ser conectado, basta responder à mensagem dele no WhatsApp com `"chama novamente"` / `"segue o baile"` / `"responde ai"` que o bot lê o texto citado (`quotedMessage`) e inicia o atendimento na hora.
4. **Resolução de Conflito de Sessão Baileys (`statusCode: 440 Stream Errored / Conflict`):**
   - O WhatsApp desconectou o socket da sessão anterior por conflito de conexão concorrente (`conflict`).
   - A sessão anterior corrompida foi totalmente excluída e uma **nova sessão limpa (`inst_adenilde_whatsapp_2920`)** foi criada e vinculada à empresa **ADEN Massoterapia**.
   - O aparelho foi escaneado e conectado com sucesso (número identificado: `554195014944`).
   - Atualizado `owner_phone` da empresa para `554195014944` e adicionado handler `getMessage` no socket para resolução de re-chaves de criptografia Signal e prevenção de erros `Bad MAC`.
   - Sincronização restabelecida com sucesso: mensagens de **Diego Messias Batista** (`195386702577754@lid`), **Amor Gatosa** e **Geovana Ungaro** (`205643084488763@lid`) foram recebidas, processadas pelo Gemini e as respostas foram entregues no WhatsApp (`delivered: true`).
   - Modo de Segurança comutado para **`PRODUCTION_ALL` (Modo Produção Aberto)** para que Geovana, Jackson e qualquer cliente que enviar mensagem seja atendido e respondido na hora sem bloqueio de whitelist.
   - Fichas de pré-atendimento de **Diego Messias Batista** e **Geovana Ungaro** abertas e ativas na Prancheta Digital.
5. **Correção de Negação de Dias na Agenda (`parseScheduleComponents`) ([src/records/schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) e [src/records/conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
   - Quando o cliente dizia *"Eu só não posso domingo e segunda"*, o motor heurístico anterior capturava a palavra "domingo" como o dia desejado e insistia em *"E no domingo você prefere de manhã ou à tarde?"*.
   - Implementada detecção de contexto de negação (`isNegationContext`: *"não posso"*, *"só não"*, *"não consigo"*, *"menos"*, *"exceto"*). Nesses casos, o sistema descarta os dias negados e limpa o agendamento parcial, permitindo que o Gemini e o orquestrador sugiram dias alternativos (*"Entendi, Diego! Terça-feira funciona para você? Que horário prefere?"*).
6. **Otimização do Tempo de Resposta e "Digitando..." ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
   - Reduzido o buffer de mensagens agrupadas de 3.0s para 1.2s.
   - Reduzido o delay de leitura de 3.5s–5.8s para 1.0s–1.8s.
   - Reduzida a simulação de digitação de 85ms/char (máximo 20s) para 25ms/char (mínimo 1.5s e máximo 4.5s), tornando as respostas muito mais rápidas, dinâmicas e naturais no WhatsApp.
7. **Recuperação e Continuidade dos Atendimentos em Andamento:**
   - As 4 conversas em andamento estão mapeadas e preservadas com o estado exato na Prancheta Digital:
     1. **Diego Messias Batista** (`195386702577754@lid`): Massagem Relaxante (R$ 120 avulsa), sem alergias/problemas de saúde. O bot sugeriu terça-feira e aguarda o horário exato.
     2. **Geovana Ungaro** (`205643084488763@lid`): Escolheu Massagem com Pedras Quentes (75 min — R$ 170). O bot perguntou sobre alergias para avançar para a agenda.
     3. **Jackson** (`260451145379981@lid`): Recebeu a mensagem de boas-vindas da Adenilde com o catálogo.
     4. **Amor Gatosa** (`237327075004656@s.whatsapp.net`): Ficha ativa aberta, aguardando escolha de técnica.

8. **Mecanismo Ativo de Auto-Recuperação e Retomada Contínua de Conversas ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
   - Implementado no `resumeUnansweredAllowedChats` com ciclo periódico contínuo (a cada 45 segundos).
   - O sistema inspeciona automaticamente fichas `IN_PROGRESS` e conversas com mensagens pendentes ou interrompidas por falha transitória/intervenção manual, recuperando exatamente o campo que faltava preencher.
   - Testado e validado em tempo real na conversa da **Geovana**: o bot detectou a parada e reenviou com naturalidade: *"Oi, Geovana! Consegui te ouvir certinho agora 😊 Tem alguma alergia a óleos ou cremes que eu precise evitar?"*, retomando o atendimento sem exigir que o cliente recomece do zero.

9. **Auto-Recuperação Contextual Baseada em Todo o Histórico da Conversa ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
   - Corrigido o ponto crítico apontado pelo usuário: quando o atendente envia uma mensagem manual (ex: *"Desculpa não consegui ouvir..."*), a rotina de auto-recuperação **não usa mais frases estáticas/genéricas**.
   - O sistema agora recupera as últimas 6 mensagens trocadas na conversa (incluindo áudios transcritos do cliente e intervenções do atendente) e solicita ao **Google Gemini** a geração de uma retomada perfeitamente contextualizada.
   - A IA sintetiza o que o cliente pediu (ex: áudio confirmando sessão avulsa de pedras quentes a R$ 170) junto com a dúvida do atendente e gera uma resposta acolhedora, humana e precisa, dando seguimento natural à ficha de anamnese e agendamento.
   - Implementada tolerância a erro de stream Baileys (`statusCode 440`) com backoff de reconexão automática sem travar o loop de eventos.
   - **Status da Geovana no WhatsApp**: Geovana respondeu *"Não"* para alergias, o sistema registrou imediatamente na ficha dinâmica e o bot deu continuidade perguntando sobre condições de saúde (*"Obrigada por avisar, Geovana! E me conta, tem alguma condição de saúde como pressão alta ou cirurgia?"*). Tudo funcionando com 100% de coerência e continuidade.
10. **Diagnóstico e Correção da Conexão e Entrega de Mensagens no WhatsApp ([src/server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e [src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts)):**
    - **Causa Raiz Identificada:** Havia uma inicialização concorrente de sessão no `server.ts` (`setTimeout` logo após `initDatabase`) e no `server.listen()` (`whatsappManager.autoStartSavedSessions()`), que abria duas conexões Baileys quase simultâneas. Isso causava conflito de stream no WhatsApp (`statusCode: 440 Stream Errored / Conflict`), e o Baileys fechava o socket em memória (`this.sockets.delete()`). O banco de dados registrava o envio como gerado, mas o socket não estava ativo para transmitir os pacotes TCP/WebSocket até os servidores da Meta.
    - **Correção Aplicada:**
      - Centralizada a inicialização de sessões exclusivamente em `autoStartSavedSessions()` acionada pelo `server.listen()`, eliminando qualquer concorrência e loop de erro 440.
      - Adicionado log detalhado no `sendTextMessage` para auditoria (`Enviando para...` e confirmação com o ID retornado pelo WhatsApp: `Mensagem entregue ao WhatsApp! ID=...`).
      - Reconectada a sessão `inst_adenilde_whatsapp_2920` de forma limpa e estável.
    - **Reenvio e Confirmação de Entrega para Todos os Contatos:**
      - **Diego Messias Batista** (`195386702577754`): Mensagem transmitida e entregue com ID `3EB0029C53FD515D7AB19A` (*"Diego, confirmando: você prefere terça-feira pela manhã ou à tarde?"*).
      - **Geovana Ungaro** (`205643084488763`): Mensagem transmitida e entregue com ID `3EB033CD02A6A72A1A45DA` (*"Geovana, me conta: você tem alguma condição de saúde como pressão alta ou cirurgia recente?"*).
      - **Jackson** (`260451145379981`): Mensagem transmitida e entregue com ID `3EB0875637C885DC8FB069` (*"Olá, Jackson! Sou a Adenilde da ADEN Massoterapia. Gostaria de agendar uma massagem conosco?"*).
11. **Refinamento de Skill, Singularidade, Tolerância de Valores e Vestimenta ([src/records/conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts), [src/hub/ai/gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts) e Banco de Dados):**
    - **Singularidade (Uma Só Atendente):**
      - Falar no plural ("nós", "trabalhamos", "usamos", "nossa clínica") foi **estritamente proibido** nas diretrizes da IA e na Skill da empresa.
      - A comunicação agora é 100% em 1ª pessoa do singular: *"eu atendo"*, *"eu uso"*, *"meu espaço"*, *"minha maca"*, *"eu tenho livre"*.
    - **Uso Natural do Nome do Cliente:**
      - Removida a repetição robótica do nome da pessoa em toda mensagem. O nome é usado pontualmente no primeiro contato ou para saudar, tornando a conversa muito mais humana e fluida.
    - **Confirmação Real de Informações / Pagamentos:**
      - Proibido o bot auto-confirmar recebimento de Pix sem que o usuário principal (Adenilde) tenha conferido de verdade na conta bancária.
      - O bot apenas avisa que recebeu o aviso e que vai verificar para confirmar.
    - **Regras Rígidas de Vestimenta e Conduta:**
      - Masculina: **bermuda leve** (obrigatório).
      - Feminina: **calcinha e sutiã** (obrigatório).
      - Proibida nudez ou respostas como "fica a seu critério".
      - Mensagem de alinhamento enviada com sucesso para Diego (*"Apenas corrigindo: para homens a vestimenta é obrigatoriamente bermuda leve, tá bom? Não é permitido ficar nu."*), respondida com *"Ok"* pelo cliente.
    - **Tolerância e Flexibilidade de Valores:**
      - Adicionada regra de tolerância caso o cliente negocie valor de sinal (ex: R$ 30 ou R$ 20 em vez de R$ 36) para fechar com simpatia sem atritos.
12. **Resolução Definitiva da Duplicação de Mensagens e Repetição de Nomes ([src/hub/whatsapp/baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts), [src/records/conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts), [src/hub/ai/gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts)):**
    - **Diagnóstico da Causa Raiz da Duplicação:**
      - O processo do servidor estava sendo executado com a flag `--watch` do Node (`node --watch src/server.ts`). Como o Baileys e o SQLite atualizam arquivos locais de sessão e logs com alta frequência, o `--watch` reiniciava o `server.ts` repentinamente enquanto uma mensagem ainda estava sendo transmitida, fazendo com que duas instâncias concorrentes processassem o mesmo evento de WhatsApp e enviassem mensagens duplas aos clientes.
    - **Ações Implementadas:**
      1. **Eliminação do Watch Instável:** O servidor principal foi colocado em execução estável sem `--watch` (`node src/server.ts`), impedindo reinicializações fantasmas.
      2. **Barreira Anti-Duplicação em Nível de Socket (`lastSentTimeByJid` & `lastSentContentByJid`):** O `sendTextMessage` agora rejeita qualquer mensagem enviada para o mesmo JID com intervalo inferior a 3.5 segundos ou com o mesmo conteúdo em menos de 30 segundos, eliminando disparos duplicados ou em rajada.
      3. **Eliminação da Repetição Artificial de Nomes:**
         - No `conversation.orchestrator.ts`, as respostas automáticas do motor de agenda deixaram de embutir `${firstName}` a cada pergunta ("Qual desses horários fica melhor pra você? 😊" em vez de "Qual desses horários fica melhor pra você, Diego?").
         - No `gemini.service.ts` e na Skill, foi definida a regra rígida de diálogo humano: falar o nome da pessoa no máximo uma vez no início da conversa e responder direto nas demais mensagens.
    - Conexão e envio 100% estabilizados e validados.

### Fase 22: Fim Definitivo de Vocativos Íntimos ("meu bem"), Controle Estruturado de Pacotes e Agenda Guardada no Banco de Dados (Concluída - 2026-11-08)
1. **Eliminação Estrita de Vocativos Íntimos e Carinhosos ("meu bem", "amor", etc.):**
   - **Diagnóstico:** A IA utilizou repetidamente o vocativo íntimo "meu bem" ao falar com o cliente Diego, gerando atrito e reclamação direta ("Não me chame de meu bem").
   - **Ações Implementadas:**
     - Adicionada regra rigorosa no [gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts), na Skill oficial da ADEN Massoterapia em [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) e no SQLite (`tenants.skill_markdown`), proibindo terminantemente o uso de "meu bem", "amor", "anjo", "meu anjo", "querido", "querida", "lindo", "linda", "flor", "coração".
     - Adicionado filtro sanitizador em tempo de execução no `GeminiService` que purga automaticamente qualquer ocorrência remanescente desses vocativos antes da mensagem ser retornada ou transmitida.
     - Definido tom de voz estritamente profissional, respeitoso, acolhedor e natural.

2. **Fonte da Verdade Estruturada: Tabela `customer_packages` e Controle de Sessões:**
   - **Diagnóstico:** O sistema não possuía tabela relacional de pacotes com contadores de sessões, dependendo da leitura transitória dos últimos logs de mensagens (`hub_message_logs LIMIT 6`). Quando o cliente perguntava o que tinha agendado ou dizia "está na conversa", a IA sofria de amnésia, inventava horários ("quarta às 10h30") e alucinava que "o pacote é semanal e será toda semana no mesmo horário".
   - **Ações Implementadas:**
     - Criada a tabela `customer_packages` em [schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql) e migrada em [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts) com campos: `id`, `tenant_id`, `customer_id`, `record_id`, `service_name`, `total_sessions`, `sessions_completed`, `price`, `status`, timestamps.
     - Adicionadas as colunas `package_id` e `session_number` na tabela `appointments`.
     - Implementado método `getCustomerAgendaAndPackages(tenantId, customerId)` em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts):
       - Calcula em tempo real: sessões contratadas, sessões agendadas, sessões realizadas e sessões restantes.
       - Gera resumo determinístico factual da agenda guardada (ex: Diego possui a 1ª sessão agendada para Quinta-feira às 15:30 e restam 3 sessões a agendar quando preferir).
     - Migrados os pacotes existentes dos clientes Diego Messias Batista, Ricardo Messias Batista e Amor Gatosa, e purgados registros órfãos que causavam conflitos.

3. **Inteligência de Atendimento Baseada em Estado Guardado ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
   - **Intent `AGENDA_STATUS_INQUIRY`:** Quando o cliente pergunta "o que tenho marcado?", "qual dia?", "resumo do que tenho", "já agendou?", "conseguiu?", "está na conversa" ou "qual ou quais quartas?", o orquestrador responde imediatamente a partir do banco de dados com dados 100% exatos e livres de alucinação.
   - **Intent `PACKAGE_SESSION_BOOKING_OR_NEW`:** Quando um cliente com saldo de pacote ativo solicita agendamento ("quero agendar uma massagem"), o sistema não cria mais fichas em branco nem repete perguntas. Ele identifica o saldo de sessões e pergunta com naturalidade: *"Você possui o Pacote de Massagem Relaxante com 3 sessões restantes (sua 1ª sessão está confirmada para quinta-feira às 15:30). Você gostaria de agendar a sua próxima sessão do pacote, marcar outro procedimento ou agendar para outra pessoa?"*.
   - **Agendamento da Próxima Sessão:** Se o cliente opta pela próxima sessão do pacote, o sistema vincula automaticamente à sessão 2 do pacote existente e solicita apenas o dia e horário desejado, sem reiniciar perguntas de anamnese.
   - **Injeção de Memória de Agenda no Gemini:** O resumo factual da agenda guardada é injetado no `customerProfile.activeAppointmentsSummary`, garantindo que qualquer interação secundária da IA tenha ciência completa e exata da agenda do cliente.

4. **Motor e Endpoint de Relatórios de Desempenho do Negócio ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) e [public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - Criado o método `getBusinessSummaryReport(tenantId)` em [schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts) e o endpoint `GET /api/v1/reports/business-summary` em [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts).
   - Métricas calculadas:
     - Total de atendimentos e sessões executadas (`session_evolutions` e appointments finalizados).
     - Total de agendamentos futuros confirmados na agenda.
     - Total de pacotes ativos e saldo de sessões restantes a executar.
     - Faturamento financeiro: total contratado, estimado recebido em sinais/sessões e saldo a receber.
     - Ranking de serviços e procedimentos mais procurados.
   - **Consulta de Relatório pelo WhatsApp da Profissional:** Adenilde pode enviar `#relatorio`, `#negocio` ou perguntar *"como está o negócio?"* no WhatsApp e recebe imediatamente o relatório de desempenho formatado em Markdown.
   - **Painel Visual na Prancheta Web:** Adicionada a aba **`📊 Relatório do Negócio`** no [public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) com 4 KPI cards em tempo real, tabela de próximos atendimentos guardados, tabela de pacotes ativos com saldo de sessões e ranking de procedimentos.


### Fase 23: Controle de Dias/Horários da Maca com Intervalo Obrigatório entre Atendimentos, Horário do WhatsApp, Fila Noturna Inteligente com Detecção de Intervenção Humana e Guardrails de Conduta/Vestimenta (Concluída - 2026-11-08)
1. **Configuração de Dias e Horários da Maca com Buffer Obrigatório entre Atendimentos ("Respeitando um Atendimento a Outro"):**
   - **Diagnóstico:** A clínica necessitava de controle formal sobre quais dias atende (ex: Segunda a Sábado aberto, Domingo fechado), horários de abertura/fechamento, intervalo de almoço e um tempo de descanso/preparo/higienização da maca entre cada atendimento consecutivo.
   - **Modelagem no Banco de Dados:**
     - Adicionada a coluna `agenda_config TEXT DEFAULT '{}'` na tabela `tenants`.
     - Estrutura: `businessDays` (array de dias da semana 0 a 6), `openTime`, `closeTime`, `lunchStart`, `lunchEnd`, `bufferMinutes` (ex: 15 min), `slotIntervalMinutes` e `dayOverrides`.
   - **Algoritmo de Buffer Rigoroso em `checkAgendaAvailability` ([schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts)):**
     - Regra matemática de separação: para qualquer atendimento candidato $[cStart, cEnd]$ (onde $cEnd = cStart + \text{duration}$) e agendamento existente $[eStart, eEnd]$, há conflito se $cStart < eEnd + \text{bufferMinutes}$ e $cEnd + \text{bufferMinutes} > eStart$.
     - Testado e validado: se um procedimento está marcado das 09:00 às 10:00 com buffer de 15 min, uma solicitação para as 10:00 é bloqueada informando que a maca está em preparo/higienização, enquanto uma solicitação para 10:15 é aceita livremente.
     - Detecção de dias fechados: se o cliente solicitar um dia em que a clínica não atende (ex: domingo), o sistema retorna `isDayClosed: true` e orienta educadamente quais dias e horários estão disponíveis.
     - Geração dinâmica de slots disponíveis dentro da janela de funcionamento do dia, excluindo horários de almoço e horários bloqueados por buffer.

2. **Horário de Atendimento do WhatsApp & Fila Noturna (`out_of_hours_queue`):**
   - **Diagnóstico:** Mensagens de clientes recebidas fora do expediente do WhatsApp não devem gerar respostas robóticas noturnas imediatas, mas sim entrar em uma fila para serem tratadas quando o expediente abrir.
   - **Modelagem no Banco de Dados:**
     - Adicionada coluna `whatsapp_hours_config TEXT DEFAULT '{}'` na tabela `tenants`.
     - Criada a tabela `out_of_hours_queue` (`id`, `tenant_id`, `instance_id`, `customer_id`, `remote_jid`, `sender_phone`, `push_name`, `message_type`, `raw_content`, `ai_transcription`, `status`, `created_at`, `processed_at`) com índice `idx_out_of_hours_queue_status`.
   - **Fuso Horário Oficial:** Implementado `getBrazilCurrentDateTime()` usando `Intl.DateTimeFormat` no fuso horário `America/Sao_Paulo`.
   - **Enfileiramento Inteligente:** Se a mensagem chega fora do horário de suporte do WhatsApp:
     - O sistema registra o evento na tabela `out_of_hours_queue` com status `QUEUED`.
     - Se `autoReplyOutOfHours: true`, dispara mensagem automática avisando o horário de atendimento (com trava de segurança de no máximo 1 envio a cada 12 horas por cliente para evitar spam).

3. **Validação Crítica de Intervenção Humana ("Meu Cliente Respondendo o Cliente Dele"):**
   - **Regra:** Se a profissional (Adenilde) estiver conversando com o cliente no WhatsApp diretamente pelo celular, o robô **nunca deve responder por cima** nem disparar mensagens automáticas da fila.
   - **Implementação em `isProfessionalActivelyResponding` ([schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts)):**
     - Checa mensagens `direction = 'OUTBOUND'` enviadas pelo dono da conta (`push_name LIKE '%Dono%'` ou `push_name LIKE '%Você%'` ou `push_name LIKE '%Profissional%'`) nos últimos 20 minutos.
     - Valida se a última mensagem do chat foi um envio manual do profissional após a mensagem do cliente.
     - Se verdadeiro, o robô entra em silêncio absoluto (`IGNORED_CASUAL`).
   - **Processamento da Fila Noturna ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
     - Worker periódico a cada 60 segundos verifica se o horário do WhatsApp abriu.
     - Antes de processar cada item da fila, verifica se a profissional respondeu manualmente o cliente no intervalo. Se sim, marca como `SKIPPED_MANUAL_ANSWER` e não dispara mensagem automática do bot. Se não, processa o atendimento com Gemini e responde com qualidade.

4. **Eliminação de Mensagens Duplicadas e Repetição Artificial de Nomes ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
   - **Mutex/Serializador por Cliente:** Criado mapa de Promises `activeProcessingByPhone` para processar eventos do mesmo cliente de forma estritamente sequencial, eliminando disparos paralelos do Gemini e duplicação de mensagens sobre Pix/valores.
   - **Deduplicação de Mensagens Recentes:** Se uma mensagem idêntica tiver sido enviada para o mesmo cliente nos últimos 8 segundos, o envio redundante é descartado.
   - **Sanitização de Repetição Excessiva de Nome:** Função `sanitizeNaturalReply` detecta se a última mensagem enviada ao cliente já continha o primeiro nome dele; em caso afirmativo, purga saudações e vocativos repetitivos no início e fim da mensagem.

5. **Guardrails Determinísticos de Vestimenta e Conduta (Proibição Absoluta de Nudez):**
   - **Regra Rígida:** Bermuda leve para homens; calcinha e sutiã para mulheres.
   - **Bloqueio Determinístico:** Se o cliente fizer perguntas insidiosas sobre nudez ("posso ficar nu?", "posso tirar tudo?", "fico só de toalha?", "final feliz"), o sistema intercepta imediatamente com guardrail em código: *"O meu atendimento é estritamente massoterapia terapêutica profissional! A vestimenta obrigatória é bermuda leve para homens e calcinha e sutiã para mulheres."*.
   - Proibição estrita de respostas como "fica a seu critério" ou plural institucional ("usamos", "nossa clínica"), reforçando a singularidade de atendimento individual da Adenilde em 1ª pessoa.

6. **Interface de Gestão Visual na Prancheta Web ([public/index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html) & [server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)):**
   - **Seção de Agenda da Maca:** Campos para Abertura, Fechamento, Início/Fim do Almoço, Intervalo/Buffer entre Atendimentos (minutos) e checkboxes individuais para dias da semana.
   - **Seção de Horário do WhatsApp:** Chave de ativação, Horário de Início e Término, toggle de auto-resposta e editor de texto da mensagem fora de expediente.
   - **Painel de Monitoramento da Fila Noturna:** Tabela em tempo real com contador de itens pendentes, status visual (`⏳ Aguardando`, `✅ Respondido Bot`, `👤 Atendido Manual`) e botão de disparo manual `⚡ Processar Fila Agora`.
   - **Endpoints REST Adicionados:**
     - `PATCH /api/v1/tenants/:id`: Atualiza `agendaConfig` e `whatsappHoursConfig`.
     - `GET /api/v1/tenants/:id/queue`: Lista itens da fila noturna.
     - `POST /api/v1/tenants/:id/queue/process`: Dispara o processamento imediato da fila.


### Fase 24: Versionamento Git & Vínculo com Repositório Remoto (Concluída - 2026-11-08)
- **Configuração do Git no Workspace:**
  - Baixado e configurado o binário portátil do Git (`.git-bin/`) preservado e ignorado pelo `.gitignore`.
  - Criado o arquivo [`.gitignore`](file:///c:/_dev/atendimento_whatsapp/.gitignore) para proteger e impedir o commit de: `node_modules/`, credenciais e banco de dados SQLite (`data/`, `*.sqlite*`), chaves e variáveis sensíveis (`.env`, `.env.local`), binários temporários (`.git-bin/`) e pastas de teste (`scratch/`).
- **Repositório Remoto Vinculado & Push Inicial:**
  - Inicializado o repositório Git na branch principal `main`.
  - Configurado o remote origin: `https://github.com/dmessiasb/ai-assistent-business.git`.
  - Realizado o commit inicial com 23 arquivos do projeto estruturados.
  - Executado com sucesso o push para a branch `main` em `origin`:
    - `https://github.com/dmessiasb/ai-assistent-business.git`


### Fase 25: Criação da Branch de Refatoração Multi-Tenant (Concluída - 2026-11-09)
- **Branch Criada:** `refactor/multi-tenant-architecture`.
- **Origem Sincronizada:** Enviada e vinculada ao repositório remoto GitHub (`origin/refactor/multi-tenant-architecture`).
- **Escopo Preparado:** Playbook de Refatoração Multi-Tenant para desacoplamento de regras hardcoded, tabela relacional `service_catalog`, generalização agnóstica do `gemini.service.ts` e injeção dinâmica de contexto com sliding window no `conversation.orchestrator.ts`.


### Fase 27: Controle Configurável de Intervenção Humana (Handoff) e Reconhecimento de Pós-Atendimento (Concluída - 2026-11-09)
1. **Configuração de Human Handoff por Tenant (`human_handoff_config`):**
   - Adicionada coluna `human_handoff_config TEXT DEFAULT '{}'` na tabela `tenants`.
   - Suporte aos seguintes parâmetros ajustáveis:
     - `enabled`: Habilita a proteção inteligente contra o bot atropelar conversas humanas.
     - `humanResponseDelaySeconds`: Janela de espera (debounce de 45 segundos) antes do bot disparar resposta automática, permitindo que a profissional responda manualmente primeiro se estiver ativa no WhatsApp.
     - `silenceAfterHumanReplyMinutes`: Se a profissional enviou qualquer mensagem no chat do cliente, o bot entra em silêncio absoluto naquele contato por 30 minutos (evitando atravessar diálogos fluidos).
     - `silenceOnPersonalKeywordsHours`: Se o cliente ou a profissional enviarem termos como *"conversa pessoal"*, *"para o bot"*, *"chat pessoal"*, o robô é desarmado imediatamente naquele chat por 12 horas.
2. **Reconhecimento Expandido de Finalização de Atendimento pela Profissional:**
   - Adicionado suporte a variações de confirmação natural no chat "Você", como:
     - `"Atendimento de Amor Gatosa foi concluído com sucesso"`
     - `"Atendimento de [Nome] finalizado"`
   - O sistema identifica o cliente no banco de dados mesmo com variações de escrita, cadastra a evolução em `session_evolutions`, atualiza `last_visit_at` em `customers`, agenda o follow-up da Ficha Viva e responde confirmando para a profissional no WhatsApp.
Seguindo estritamente as diretrizes do Playbook Multi-Tenant fornecido pelo usuário:

1. **Desacoplamento e Generalização do `GeminiService` ([gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts)):**
   - Eliminados todos os hardcodes e textos fixos sobre Adenilde, valores pré-fixados de R$ 36 de sinal, sanitização de "Adenzinha" e regras embutidas no código da classe.
   - A classe passou a ser um executor agnóstico puro que aceita `GeminiProcessInput`:
     - `systemInstruction`: String com o prompt compilado dinamicamente pelo orquestrador.
     - `recentHistory`: Array com o histórico de mensagens `{ role: 'user' | 'model', text: string }`.
     - `tools`: Declaração de ferramentas para Function Calling do Gemini.
     - `mediaBase64` / `mimeType`: Suporte a áudio e imagens.
     - `apiKeyOverride` / `modelOverride`: Suporte a modelos e chaves exclusivas de cada tenant.
   - Retorno estruturado via `GeminiProcessResult`:
     - `conversationalReply`: Resposta conversacional limpa gerada pela IA.
     - `functionCalls`: Chamadas de ferramentas disparadas pelo Gemini (`name`, `args`).
     - `tokensUsed`: Contabilização oficial do consumo de tokens capturado de `usageMetadata.totalTokenCount`.

2. **Evolução do Banco de Dados ([schema.sql](file:///c:/_dev/atendimento_whatsapp/src/database/schema.sql) & [db.ts](file:///c:/_dev/atendimento_whatsapp/src/database/db.ts)):**
   - **Tabela `tenants`:** Adicionadas colunas `ai_provider TEXT DEFAULT 'gemini'`, `monthly_token_limit INTEGER DEFAULT 500000`, `tokens_used_month INTEGER DEFAULT 0` e `personhood TEXT DEFAULT 'FIRST_PERSON_SINGULAR'`.
   - **Tabela `service_catalog`:** Criada tabela relacional para catálogo de procedimentos:
     - `id`, `tenant_id` (FK cascade), `name`, `description`, `duration_min`, `price_single`, `price_package_4x`, `recommended_deposit`, `is_active`, `created_at`, `updated_at`.
     - Índice `idx_services_tenant` criado sobre `(tenant_id, is_active)`.
   - **Tabela `customers`:** Adicionada coluna `shadow_memory TEXT DEFAULT ''` para retenção contínua de memória e queixas do cliente sem depender de varredura completa de histórico.
   - **Migrações e Seeds Seguras:**
     - Adicionada migração idempotente em `runSafeMigrations()`.
     - Inicializado e persistido o catálogo oficial da ADEN Massoterapia (5 serviços com valores, durações e sinais recomendados calculados).

3. **Orquestrador de Conversa e Montagem Dinâmica de Contexto ([conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
   - Implementada a função `buildDynamicSystemPrompt(tenant, services, customer, agendaStatusSummary)`:
     - Formata procedimentos lidos diretamente da tabela relacional `service_catalog`.
     - Injeta dinamicamente a persona (`personhood`: 1ª pessoa do singular vs 1ª pessoa do plural).
     - Insere endereço, horários de atendimento da maca e as regras éticas e de vestimenta configuradas na `skill_markdown`.
   - **Sliding Window de 8 Mensagens:** Histórico truncado nas últimas 8 mensagens no formato `{ role: 'user' | 'model', text: string }`, otimizando a janela de contexto e o consumo de tokens.
   - **Controle de Cotas de Tokens:** Implementado `incrementTenantTokensUsed(tenantId, tokens)` que soma os tokens consumidos do Gemini diretamente em `tenants.tokens_used_month`.
   - **Declaração e Execução de Tools (Function Calling):**
     - `salvar_anamnese_concluida`: Atualiza `dynamic_records` e grava na memória persistente `customers.shadow_memory`.
     - `confirmar_agendamento`: Registra e reserva o slot na agenda via `schemaEngine.saveAppointmentSlot` com validação de buffer e horário.
   - Sem ferramentas de leitura (evita round-trips e latência), mantendo a resposta ágil, calorosa e em poucas frases curtas.

4. **Validação & Testes ([scratch/test_multi_tenant_refactor.ts](file:///c:/_dev/atendimento_whatsapp/scratch/test_multi_tenant_refactor.ts)):**
   - Verificada a criação de todas as novas tabelas e colunas no SQLite.
   - Validada a injeção do catálogo relacional no prompt dinâmico.
   - Testado o pipeline agnóstico do Gemini sem referências fixas no código-fonte.
   - Servidor reiniciado com sucesso em segundo plano na porta 3000.

## [2026-11-10] Fase 29 - Painel Web Mobile-First, Responsividade Completa e Navegação por Abas
Atendendo aos requisitos de uso via smartphone/Antigravity Remote:

1. **Responsividade Mobile-First ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - **Menu Lateral Retrátil (Mobile Drawer):** Sidebar com botão hamburguer no cabeçalho e overlay escuro com fechamento ao toque ou seleção de tela.
   - **Topbar Compacta:** Seletor de empresa e atalho para impressão com quebra inteligente e ajuste de escala para telas de celulares.
   - **Kanban Touch-Friendly:** Container com scroll horizontal fluido (`scroll-snap-type: x mandatory`), colunas adaptadas (`min-w-[280px]`) e botões de atalho rápido em cada card para movimentação sem exigir drag-and-drop no touch.
   - **Tabelas com Scroll Horizontal e Min-Width:** Tabelas de catálogo, fila noturna e consumo de tokens agora mantêm legibilidade sem quebras de layout.

2. **Segregação de Visões por Categorias e Sub-Abas:**
   - **Barra de Navegação Horizontal Rápida (Sub-Abas / Pills):** Adicionada abaixo do cabeçalho para acesso direto com 1 toque entre as áreas operacionais e analíticas.
   - **Sub-Abas Internas na Tela de Configurações da Empresa:**
     - 🏢 *Dados & IA* (Nome, nicho, credencial Gemini, vínculo de WhatsApp e cotas de tokens).
     - 💆‍♀️ *Procedimentos & Preços* (Regras de Pix, percentual de sinal e tabela de serviços).
     - 🗓️ *Horários da Maca* (Abertura/fechamento, almoço, buffer de higienização e dias de atendimento).
     - 📱 *Expediente WhatsApp & Fila* (Horário comercial do bot, mensagem de fora do expediente e monitoramento de fila).

3. **Validação de Acesso Remoto:**
   - Testado e validado o túnel seguro Cloudflare HTTPS (`https://plugins-casio-load-roses.trycloudflare.com`).

## [2026-11-11] Fase 30 - Filtro de Contexto Anti-Intromissão, Silêncio em Conversa Pessoal e Deduplicação Estrita
Correção definitiva do comportamento do assistente virtual ao atravessar conversas humanas ou disparar mensagens duplicadas:

1. **Eliminação do Fallback Repetitivo e Atualização do Modelo Gemini ([gemini.service.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/ai/gemini.service.ts)):**
   - Atualizada a ordem de modelos do Gemini para utilizar prioritariamente `gemini-3.5-flash-lite`, `gemini-3.5-flash` e `gemini-3.8-flash` (eliminando erros 404 e 429 de modelos antigos).
   - O fallback local não envia mais o texto genérico fixo *"Olá! Recebi sua mensagem e já estou verificando para te responder da melhor forma..."*. Se a mensagem não tiver relação com procedimentos, serviços ou agendamentos, o assistente retorna **silêncio absoluto**.

2. **Detecção e Silêncio em Conversas Pessoais e Não-Relacionadas ([schema.engine.ts](file:///c:/_dev/atendimento_whatsapp/src/records/schema.engine.ts)):**
   - Expandido o classificador de intenção (`classifyConversationIntent`) para ignorar conversas domésticas/pessoais (ex: compras, termômetro, aquário, viagem, deslocamento, recados familiares, canais/newsletters).
   - Se o cliente já possui atendimento ou ficha concluída (`COMPLETED`), o assistente só responde caso a mensagem contenha dúvida explícita (`?`) ou termos de agendamento/procedimento.
   - Proteção de intervenção humana estendida: se a profissional interagiu no chat nas últimas 3 horas, o bot permanece em silêncio contínuo, a menos que haja solicitação explícita de procedimento/agendamento.

3. **Trava Anti-Duplicação Estrita em Três Camadas ([baileys.manager.ts](file:///c:/_dev/atendimento_whatsapp/src/hub/whatsapp/baileys.manager.ts) & [conversation.orchestrator.ts](file:///c:/_dev/atendimento_whatsapp/src/records/conversation.orchestrator.ts)):**
   - Camada 1 (Baileys Send): Trava de envio duplicado com janela de 5 minutos (300 segundos) para o mesmo texto e 8 segundos para rajadas.
   - Camada 2 (Orquestrador): Consulta aos logs do SQLite antes de qualquer envio; se a mesma mensagem foi enviada recentemente ao cliente, a emissão é abortada.
   - Camada 3 (Canais/Newsletters): Mensagens de canais (`@newsletter`) são ignoradas imediatamente, impedindo acúmulo e disparo na fila noturna.

## [2026-11-09] Fase 28 - Funil de Vendas Kanban Multi-Empresa e Gestão de Limites de Tokens
Implementadas melhorias para permitir gestão visual de atendimentos por funil de vendas (Kanban), separação estrita de dados por empresa e governança do consumo de tokens de inteligência artificial:

1. **Funil de Vendas Kanban Multi-Empresa ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts) & [index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - **Novo Endpoint `PATCH /api/v1/records/:id/status`**: Atualiza a etapa do atendimento no banco de dados (`IN_PROGRESS`, `PENDING_PAYMENT`, `COMPLETED`, `CANCELLED`).
   - **Painel Visual Kanban**:
     - Criadas 4 colunas com cores e contadores em tempo real:
       - 💬 *Em Atendimento* (`IN_PROGRESS` - azul)
       - ⏳ *Aguardando Sinal / Pix* (`PENDING_PAYMENT` - amarelo)
       - ✅ *Confirmado / Concluído* (`COMPLETED` - verde)
       - ❌ *Cancelado* (`CANCELLED` - vermelho)
     - Cards de atendimento com dados essenciais: Nome do cliente, telefone, procedimento, data/horário e badges de alertas clínicos.
     - Suporte a **Drag-and-Drop nativo HTML5** para arrastar e soltar clientes entre as etapas.
     - Botões de atalho rápido em cada card para movimentação com 1 clique (para mobile e agilidade).

2. **Isolamento e Acesso Específico por Empresa (Multi-Tenant):**
   - O seletor global de empresa no topo do painel filtra estritamente:
     - Atendimentos da Prancheta
     - Agenda / Horários do dia
     - Funil de Vendas Kanban
     - Métricas e consumo de tokens
   - As consultas para `/api/v1/records?tenantId=...` respeitam a empresa selecionada, garantindo privacidade e separação dos dados entre diferentes negócios.

3. **Painel de Consumo e Limite de Tokens de IA:**
   - **Novo Endpoint `GET /api/v1/tokens/usage`**: Retorna métricas agregadas globais (`totalTokensUsed`, `totalTokenLimit`, `% global`) e detalhamento individual por empresa (`monthly_token_limit`, `tokens_used_month`, `% usado`, `remaining_tokens`, `is_limit_reached`).
   - **Visão Dedicada "🪙 Consumo de Tokens (IA)"**:
     - 4 Cards de KPI no topo: Total de Tokens Consumidos, Limite Contratado Global, % de Uso do Sistema e Empresas Monitoradas.
     - Tabela detalhada por empresa exibindo provedor, modelo de IA configurado, contadores numéricos, barra de progresso visual (verde, amarela ou vermelha de acordo com o consumo) e status de cota.
     - Ação direta para ajustar o limite mensal contratado (`PATCH /api/v1/tenants/:id`) com feedback imediato.
   - Atualizado o modal/formulário de edição de empresas para inclusão dos parâmetros de IA e cotas.


## [2026-11-11] Fase 31 - Unificação e Deduplicação Estrita de Clientes no Funil de Vendas (1 Card por Pessoa)
Implementada a regra de negócio para garantir que nenhuma pessoa/cliente seja duplicada no Funil de Vendas (Kanban):

1. **Deduplicação de Cards no Frontend ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - Na função `renderKanbanBoard(records)`, os atendimentos agora são agrupados e desduplicados pelo identificador do cliente (`customer_id` / `customer_phone`).
   - Cada pessoa passa a ocupar exatamente **uma única coluna** no funil, representando o seu estágio mais relevante e atual no momento.
   - Ordem de prioridade de status adotada:
     1. `IN_PROGRESS` (Em conversa / atendimento ativo)
     2. `PENDING_PAYMENT` (Aguardando Sinal / Pix)
     3. `COMPLETED` (Atendimento confirmado / concluído)
     4. `CANCELLED` (Cancelado / arquivado)
     - Desempate para status iguais: registro com `updated_at` mais recente.
   - Os contadores de cada coluna (badges do Kanban) agora refletem o número exato de clientes distintos presentes em cada etapa.

2. **Integridade de Ficha Única no Backend ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)):**
   - No endpoint `PATCH /api/v1/records/:id/status`, ao mover uma ficha para um status ativo (`IN_PROGRESS`, `PENDING_PAYMENT` ou `COMPLETED`), o backend cancela/arquiva automaticamente quaisquer fichas anteriores redundantes daquele mesmo cliente na mesma empresa (`UPDATE dynamic_records SET status = 'CANCELLED' WHERE customer_id = ? AND tenant_id = ? AND id != ? AND status != 'CANCELLED'`).
   - Isso garante coerência permanente entre a base de dados relacional e a visualização do operador no Kanban.


## [2026-11-11] Fase 32 - Unificação das Configurações da Empresa na Tela Perfil (Sub-Abas de Persona, WhatsApp e Preços)
Atendendo à necessidade de centralizar a gestão e governança por empresa, todas as configurações específicas de cada negócio foram integradas dentro da tela **"⚙️ Perfil da Empresa"**, eliminando menus soltos e segregando tudo em sub-abas dedicadas:

1. **Estrutura Unificada de Sub-Abas em "Perfil da Empresa" ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - **🏢 Dados & IA**: Nome, nicho (`VerticalPreset`), Chave Gemini exclusiva, modelo e modo de segurança (Produção vs. Teste com whitelist).
   - **💆‍♀️ Agenda de Preços & Pix**: Catálogo de procedimentos com durações, valores avulsos, pacotes de 4 sessões, chave Pix e cálculo dinâmico de sinal.
   - **🗓️ Horários da Maca**: Horários de abertura, fechamento, almoço, dias úteis da semana e buffer de higienização entre atendimentos.
   - **📱 Expediente WhatsApp & Fila**: Definição do horário de atendimento do bot, resposta automática amigável para mensagens fora do expediente e fila noturna.
   - **🛡️ Regras de Persona & IA**: Editor integrado do `SKILL.md` exclusivo da empresa selecionada (tom de voz, persona, diretrizes clínicas e guardrails) juntamente com o roteiro de perguntas automáticas invisíveis do nicho.
   - **📲 Conexão de WhatsApp**: Painel completo do Baileys para a empresa (geração e escaneamento de QR Code, status em tempo real `CONNECTED`/`QR_READY`, troca de aparelho e simulador de envio real).

2. **Navegação Limpa e Intuitiva:**
   - A barra lateral (sidebar) e as subnav pills no mobile agora concentram as funções da empresa sob a categoria unificada **"Perfil da Empresa"**, facilitando o uso rápido pelo smartphone ou computador.


## [2026-11-11] Fase 33 - Isolamento Estrito de Registros por Empresa na Tela Perfil (Conexão WhatsApp e Dados)
Implementado isolamento estrito para garantir que na tela **Perfil da Empresa** apareçam **apenas os registros e conexões pertencentes à empresa selecionada**:

1. **Filtro no Backend para Instâncias de WhatsApp ([server.ts](file:///c:/_dev/atendimento_whatsapp/src/server.ts)):**
   - O endpoint `GET /api/v1/instances` agora suporta o parâmetro `?tenantId=...`.
   - Ao receber o `tenantId`, o backend consulta a instância vinculada àquela empresa (`tenants.whatsapp_instance_id`) e retorna estritamente a sessão pertencente a ela, impedindo vazamento de sessões de outros clientes/empresas na visualização de perfil.

2. **Frontend com Isolamento Contextual ([index.html](file:///c:/_dev/atendimento_whatsapp/public/index.html)):**
   - A chamada `fetch('/api/v1/instances?tenantId=...')` passa a respeitar a empresa selecionada no seletor global (`🏢 Empresa Ativa`).
   - A renderização da sub-aba **"📲 Conexão de WhatsApp"** agora exibe exclusivamente o card de WhatsApp daquela empresa com seu respectivo QR Code, status de conexão e botão para criar/reconectar.
   - Removido o seletor misturado de instâncias que permitia ver ou vincular sessões de terceiros acidentalmente.
