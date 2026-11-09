import crypto from 'node:crypto';
import { db } from '../database/db.ts';
import { schemaEngine } from './schema.engine.ts';

export interface GeneratedPrintSheet {
  batchId: string;
  tenantName: string;
  recordLabel: string;
  qrMode: 'STATIC_TENANT' | 'UNIQUE_PER_SHEET';
  whatsappDeepLink: string;
  qrCodeDataUrl: string;
  printableHtml: string;
}

export class PhysicalPrintGenerator {
  public async generatePrintableBlock(params: {
    tenantId: string;
    sheetsCount?: number;
    qrMode?: 'STATIC_TENANT' | 'UNIQUE_PER_SHEET';
  }): Promise<GeneratedPrintSheet> {
    const config = schemaEngine.getTenantConfig(params.tenantId);
    if (!config) {
      throw new Error(`Tenant '${params.tenantId}' não encontrado.`);
    }

    const tenantRow = db
      .prepare(`SELECT branding_config FROM tenants WHERE id = ?`)
      .get(config.tenantId) as { branding_config: string } | undefined;

    const branding = JSON.parse(tenantRow?.branding_config || '{}') as {
      primaryColor?: string;
      headerText?: string;
      footerText?: string;
    };

    const batchId = `prt_${crypto.randomUUID().slice(0, 8)}`;
    const qrMode = params.qrMode || 'STATIC_TENANT';
    const sheetCode = qrMode === 'UNIQUE_PER_SHEET' ? ` #FICHA-${batchId.toUpperCase()}` : '';
    const cleanPhone = config.ownerPhone.replace(/\D/g, '');
    const initialText = encodeURIComponent(
      `Olá! Escaneie o QR Code na recepção para preencher minha ${config.terminology.recordLabel}${sheetCode}`
    );
    const whatsappDeepLink = `https://wa.me/${cleanPhone}?text=${initialText}`;

    let qrCodeDataUrl = '';
    try {
      const QRCode = (await import('qrcode')).default;
      qrCodeDataUrl = await QRCode.toDataURL(whatsappDeepLink, { width: 220, margin: 1 });
    } catch {
      // Fallback SVG caso rode antes do npm install
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff" stroke="#0f172a" stroke-width="4"/><rect x="14" y="14" width="30" height="30" fill="#0f172a"/><rect x="76" y="14" width="30" height="30" fill="#0f172a"/><rect x="14" y="76" width="30" height="30" fill="#0f172a"/><text x="60" y="65" font-size="10" text-anchor="middle" fill="#0f172a">QR WHATSAPP</text></svg>`;
      qrCodeDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    db.prepare(
      `INSERT INTO print_batches (id, tenant_id, sheets_count, qr_mode, pdf_url) VALUES (?, ?, ?, ?, ?)`
    ).run(
      batchId,
      config.tenantId,
      params.sheetsCount || 50,
      qrMode,
      `/api/v1/tenants/${config.tenantId}/print-preview?qrMode=${qrMode}`
    );

    const primaryColor = branding.primaryColor || '#0D9488';

    const fieldsHtml = config.formSchema
      .map(
        (f) => `
        <div style="margin-bottom: 14px; border-bottom: 1px dashed #cbd5e1; padding-bottom: 10px;">
          <div style="font-weight: 600; font-size: 13px; color: #1e293b; margin-bottom: 6px;">
            ${f.label}
          </div>
          ${
            f.type === 'boolean' || f.type === 'boolean_with_details'
              ? `<div style="font-size: 12px; color: #475569;">( &nbsp; ) Não &nbsp;&nbsp;&nbsp; ( &nbsp; ) Sim — Quais/Detalhes: ___________________________________________</div>`
              : f.type === 'scale_1_10'
              ? `<div style="font-size: 12px; color: #475569;">Nível: [ 0 ] [ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ] [ 6 ] [ 7 ] [ 8 ] [ 9 ] [ 10 ]</div>`
              : `<div style="height: 22px; border-bottom: 1px solid #e2e8f0;"></div>`
          }
        </div>`
      )
      .join('');

    const printableHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>${config.terminology.recordLabel} — ${config.tenantName}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    body { font-family: 'Segoe UI', Roboto, sans-serif; color: #0f172a; margin: 0; padding: 20px; }
    .sheet { max-width: 760px; margin: 0 auto; border: 2px solid ${primaryColor}; border-radius: 12px; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid ${primaryColor}; padding-bottom: 16px; margin-bottom: 20px; }
    .qr-box { text-align: center; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px; width: 150px; }
    .print-btn { display: inline-block; margin-bottom: 16px; background: ${primaryColor}; color: white; border: none; padding: 10px 18px; border-radius: 8px; cursor: pointer; font-weight: bold; }
    @media print { .no-print { display: none !important; } body { padding: 0; } }
  </style>
</head>
<body>
  <div class="no-print" style="max-width: 760px; margin: 0 auto 12px auto; display: flex; justify-content: space-between; align-items: center;">
    <button class="print-btn" onclick="window.print()">🖨️ Imprimir Bloco / Salvar em PDF</button>
    <span style="font-size: 12px; color: #64748b;">Modo QR: <b>${qrMode}</b> | Lote: <b>${batchId}</b></span>
  </div>
  <div class="sheet">
    <div class="header">
      <div>
        <div style="font-size: 22px; font-weight: 800; color: ${primaryColor};">${config.tenantName}</div>
        <div style="font-size: 15px; font-weight: 600; color: #334155; margin-top: 4px;">
          ${branding.headerText || config.terminology.recordLabel}
        </div>
        <div style="font-size: 12px; color: #64748b; margin-top: 4px;">
          Nicho configurado: ${config.presetName}
        </div>
      </div>
      <div class="qr-box">
        <img src="${qrCodeDataUrl}" style="width: 115px; height: 115px;" alt="QR Code WhatsApp" />
        <div style="font-size: 10px; font-weight: 700; color: #0f172a; margin-top: 4px;">
          PREENCHER POR VOZ NO WHATSAPP
        </div>
      </div>
    </div>

    <div style="display: flex; gap: 16px; margin-bottom: 18px; font-size: 13px;">
      <div style="flex: 2;"><b>${config.terminology.clientLabel}:</b> ________________________________________</div>
      <div style="flex: 1;"><b>WhatsApp:</b> (___) _______________</div>
      <div style="flex: 1;"><b>Data:</b> ____/____/202__</div>
    </div>

    ${fieldsHtml}

    <div style="margin-top: 22px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc;">
      <div style="font-weight: 700; font-size: 12px; margin-bottom: 8px;">
        📝 Evolução da ${config.terminology.sessionLabel} (Anotação ou Foto via WhatsApp):
      </div>
      <div style="height: 65px; border-bottom: 1px dashed #cbd5e1;"></div>
    </div>

    <div style="margin-top: 20px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #64748b;">
      <div>Assinatura / Consentimento: ________________________________________</div>
      <div>${branding.footerText || 'Bloco Híbrido Inteligente'}</div>
    </div>
  </div>
</body>
</html>`;

    return {
      batchId,
      tenantName: config.tenantName,
      recordLabel: config.terminology.recordLabel,
      qrMode,
      whatsappDeepLink,
      qrCodeDataUrl,
      printableHtml,
    };
  }
}

export const printGenerator = new PhysicalPrintGenerator();
