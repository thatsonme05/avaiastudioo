/* ═══════════════════════════════════════════════
   INVOICE PDF GENERATOR — pdfkit
═══════════════════════════════════════════════ */
const PDFDocument = require('pdfkit');

function generateInvoicePDF(booking, settings = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const studioName = settings.studioName || 'Avaia Studio';
      const primary   = settings.primaryColor || '#6B2737';
      const invNo     = 'INV-' + String(booking.id || '').toUpperCase();
      const isPaid    = booking.status === 'confirmed';
      const issuedAt  = booking.paid_at || booking.created_at || new Date().toISOString();

      // ── HEADER ──
      doc.rect(0, 0, doc.page.width, 110).fill(primary);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(studioName, 50, 38);
      doc.font('Helvetica').fontSize(10).fillColor('#f0e5e5')
        .text(settings.address || '', 50, 66)
        .text([settings.phone, settings.email].filter(Boolean).join('  ·  '), 50, 80);

      doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff')
        .text('INVOICE', 0, 40, { align: 'right', width: doc.page.width - 50 });

      // ── META INFO ──
      let y = 140;
      doc.fillColor('#1c1410').font('Helvetica-Bold').fontSize(11).text('Invoice Number', 50, y);
      doc.font('Helvetica').fontSize(11).text(invNo, 50, y + 15);

      doc.font('Helvetica-Bold').fontSize(11).text('Issue Date', 300, y);
      doc.font('Helvetica').fontSize(11).text(
        new Date(issuedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }),
        300, y + 15
      );

      y += 45;
      doc.font('Helvetica-Bold').fontSize(11).text('Payment Status', 50, y);
      doc.font('Helvetica-Bold').fontSize(11)
        .fillColor(isPaid ? '#4a7a48' : '#b52b2b')
        .text(isPaid ? 'PAID' : 'UNPAID', 50, y + 15);

      doc.fillColor('#1c1410').font('Helvetica-Bold').fontSize(11).text('Payment Method', 300, y);
      doc.font('Helvetica').fontSize(11).text(
        (booking.payment_type || '—').toUpperCase(), 300, y + 15
      );

      // ── BILL TO ──
      y += 50;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd5ca').stroke();
      y += 16;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#7a6e68').text('BILL TO', 50, y);
      y += 16;
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1c1410').text(booking.name || '—', 50, y);
      y += 17;
      doc.font('Helvetica').fontSize(10).fillColor('#7a6e68')
        .text(booking.email || '', 50, y);
      if (booking.phone) doc.text(booking.phone, 50, y + 13);

      // ── TABLE ──
      y += 55;
      const tableTop = y;
      doc.rect(50, tableTop, 495, 26).fill('#fdf8f6');
      doc.fillColor('#1c1410').font('Helvetica-Bold').fontSize(10)
        .text('CLASS', 62, tableTop + 8)
        .text('DATE', 230, tableTop + 8)
        .text('TIME', 340, tableTop + 8)
        .text('PRICE', 460, tableTop + 8, { width: 75, align: 'right' });

      y = tableTop + 26;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd5ca').stroke();
      const rowH = 32;
      doc.font('Helvetica').fontSize(11).fillColor('#1c1410')
        .text(booking.class || '—', 62, y + 10, { width: 160 })
        .text(booking.date || '—', 230, y + 10, { width: 100 })
        .text(booking.time || '—', 340, y + 10, { width: 100 });
      doc.font('Helvetica-Bold')
        .text('IDR ' + Number(booking.amount || 0).toLocaleString('en-US'), 460, y + 10, { width: 75, align: 'right' });

      y += rowH;
      doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd5ca').stroke();

      if (booking.note) {
        y += 14;
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#7a6e68')
          .text('Note: ' + booking.note, 62, y, { width: 470 });
        y += 18;
      }

      // ── TOTAL ──
      y += 20;
      doc.rect(345, y, 200, 46).fill('#fdf8f6');
      doc.font('Helvetica').fontSize(10).fillColor('#7a6e68').text('Total Paid', 360, y + 10);
      doc.font('Helvetica-Bold').fontSize(16).fillColor(primary)
        .text('IDR ' + Number(booking.amount || 0).toLocaleString('en-US'), 360, y + 24);

      // ── FOOTER ──
      const footerY = doc.page.height - 90;
      doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor('#ddd5ca').stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#7a6e68')
        .text('This invoice was generated automatically by the ' + studioName + ' system. Keep it as valid proof of payment.', 50, footerY + 12, { width: 495 })
        .text('Order ID: ' + booking.id, 50, footerY + 26);

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { generateInvoicePDF };
