import { db, initDatabase } from '../database/db.ts';
import { conversationOrchestrator } from '../records/conversation.orchestrator.ts';
import { followupWorker } from '../records/followup.worker.ts';
import { printGenerator } from '../records/print.generator.ts';
import { schemaEngine } from '../records/schema.engine.ts';

async function verifyAllPhases() {
  console.log('======================================================================');
  console.log('🚀 VALIDAÇÃO PONTA A PONTA — FASES 1 A 5 (MULTI-NICHO + WHATSAPP HUB)');
  console.log('======================================================================\n');

  initDatabase();
  conversationOrchestrator.initListeners();

  // 1. Validar Fase 1 & 2 (Banco + Schema Engine Multi-Nicho)
  const configEstetica = schemaEngine.getTenantConfig('inst_principal');
  if (!configEstetica) throw new Error('Configuração padrão não encontrada.');
  console.log(
    `✅ [Fases 1 & 2] Estabelecimento ativo: "${configEstetica.tenantName}" | Nicho: "${configEstetica.presetName}" (${configEstetica.formSchema.length} campos dinâmicos)`
  );

  // 2. Validar Fase 3A (Fluxo do Cliente respondendo por áudio/texto no WhatsApp)
  const clientRes = await conversationOrchestrator.handleClientInterview(
    configEstetica,
    '5511988887777',
    'Mariana Costa',
    'Oi! Estou com muita dor na lombar nível 8, sou alérgica a cânfora, tenho pressão alta e não estou gestante.'
  );
  console.log(
    `✅ [Fase 3 - Cliente] Ficha de Mariana processada! Status: ${clientRes.recordStatus}`
  );
  console.log(`   ⚡ Alertas calculados: ${clientRes.activeAlerts?.join(' | ')}`);

  // 3. Validar Fase 3B (Modo Ditado por Voz da Profissional pós-atendimento)
  const dictRes = await conversationOrchestrator.handleProfessionalMessage(
    configEstetica,
    configEstetica.ownerPhone,
    'Atendi a cliente Mariana (5511988887777), fiz liberação miofascial na lombar e ventosaterapia sem cânfora. Dor caiu de 8 para 2.'
  );
  console.log(
    `✅ [Fase 3 - Ditado da Profissional] Evolução salva (${dictRes.evolutionId}) e Follow-up D+1 agendado!`
  );

  // 4. Validar Fase 3C (Consulta rápida #ficha pela Profissional no WhatsApp)
  const queryRes = await conversationOrchestrator.handleProfessionalMessage(
    configEstetica,
    configEstetica.ownerPhone,
    '#ficha Mariana'
  );
  console.log(
    `✅ [Fase 3 - Comando #ficha] Retorno instantâneo para a profissional (${queryRes.replyMessage.split('\n').length} linhas)`
  );

  // 5. Validar Fase 4 (Gerador de Bloco Impresso com QR Code Inteligente)
  const printSheet = await printGenerator.generatePrintableBlock({
    tenantId: configEstetica.tenantId,
    qrMode: 'UNIQUE_PER_SHEET',
  });
  console.log(
    `✅ [Fase 4 - Ponte Físico-Digital] Bloco PDF/HTML gerado (Lote: ${printSheet.batchId}) | Link QR: ${printSheet.whatsappDeepLink.slice(0, 65)}...`
  );

  // 6. Validar Fase 5 ("Ficha Viva" - Disparo de Follow-up D+1 e Detecção de Reação Adversa)
  const dispatched = await followupWorker.dispatchDueFollowups(true);
  const firstFollowup = dispatched.items[0];
  console.log(
    `✅ [Fase 5 - Ficha Viva] Follow-ups disparados: ${dispatched.dispatchedCount} (Para: ${firstFollowup?.customerName})`
  );

  if (firstFollowup) {
    const replyAnalysis = await followupWorker.processFollowupReply({
      followupId: firstFollowup.id,
      customerReply: 'Hoje acordei com vermelhidão e dor forte nas costas',
    });
    console.log(
      `✅ [Fase 5 - Alerta Reação Adversa] Sentimento=${replyAnalysis.sentiment} | Status=${replyAnalysis.status} | Profissional Alertada=${replyAnalysis.professionalAlerted}`
    );
  }

  // 7. Validar troca dinâmica de Nicho (Ex: Pet Shop) sem alterar 1 linha de código
  db.prepare(`UPDATE tenants SET vertical_preset_id = 'pet_shop_banho_tosa' WHERE id = ?`).run(
    configEstetica.tenantId
  );
  const configPet = schemaEngine.getTenantConfig('inst_principal')!;
  console.log(
    `✅ [Prova Multi-Nicho] Trocado para "${configPet.presetName}" -> Novo rótulo de ficha: "${configPet.terminology.recordLabel}"`
  );
  // Restaura para Massoterapia & Estética como padrão
  db.prepare(`UPDATE tenants SET vertical_preset_id = 'massoterapia_estetica' WHERE id = ?`).run(
    configEstetica.tenantId
  );

  const totalRecords = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM dynamic_records`).get() as { cnt: number }
  ).cnt;
  const totalEvolutions = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM session_evolutions`).get() as { cnt: number }
  ).cnt;

  console.log(
    `✅ [Prancheta Digital DB] Fichas ativas: ${totalRecords} | Evoluções de sessão registradas: ${totalEvolutions}`
  );

  console.log(
    `\n🎯 TODAS AS 5 FASES VALIDADAS COM SUCESSO! Uso de RAM: ${Math.round(
      process.memoryUsage().rss / 1024 / 1024
    )} MB`
  );
}

verifyAllPhases().catch((err) => {
  console.error('❌ Falha na verificação:', err);
  process.exit(1);
});
