import { renderSpecimenLabelHtml } from '../../routes/lab/labRoutes.js';

describe('lab specimen label HTML rendering', () => {
  it('escapes patient and specimen fields while preserving generated barcode SVG', () => {
    const html = renderSpecimenLabelHtml({
      accession_number: 'ACC-1<script>alert(1)</script>',
      specimen_type: 'blood & urine',
      priority: 'STAT" onclick="alert(1)',
      patient: { name: '<img src=x onerror=alert(1)>' },
      svg: '<svg role="img"></svg>',
    });

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('blood &amp; urine');
    expect(html).toContain('STAT&quot; onclick=&quot;alert(1)');
    expect(html).toContain('ACC-1&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<svg role="img"></svg>');
  });
});
