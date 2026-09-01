import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function source(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('migration 753 exact claim and pre-auth authority', () => {
  it('revalidates every caller reference under the patient transaction before insert', () => {
    const claims = source('../../services/insurance/claimsService.js');
    const preauthBody = claims.slice(
      claims.indexOf('export async function createPreauth'),
      claims.indexOf('export async function getPreauth'),
    );
    const claimBody = claims.slice(
      claims.indexOf('export async function createClaim'),
      claims.indexOf('export async function getClaim'),
    );

    expect(preauthBody).toMatch(/setTenantTx[\s\S]*lockInsuranceFundingPatientTx[\s\S]*lockClaimReferenceAuthorityTx[\s\S]*INSERT INTO insurance_preauth/);
    expect(claimBody).toMatch(/setTenantTx[\s\S]*lockInsuranceFundingPatientTx[\s\S]*lockClaimReferenceAuthorityTx[\s\S]*lockClaimInvoiceAuthorityTx[\s\S]*INSERT INTO tpa_claims/);
    expect(claimBody).toMatch(/CLAIM_FINAL_INVOICE_REQUIRED/);
    expect(claims).toMatch(/FROM billing_invoice_items[\s\S]*FOR UPDATE/);
    expect(claims).toMatch(/exactNonPayableNum[\s\S]*exactClaimAmt/);
    expect(claims).toMatch(/CLAIM_POLICY_FINANCIAL_AUTHORITY_INVALID/);
    expect(claims).toMatch(/FROM billing_invoice_items[\s\S]*tenant_id = \$2::uuid[\s\S]*tpa_decision = 'non_payable'/);
    expect(claims).toMatch(/LEFT JOIN payers pa\s+ON pa\.tenant_id = p\.tenant_id/);
    expect(claims).toMatch(/LEFT JOIN insurance_policies pol\s+ON pol\.tenant_id = pre\.tenant_id/);
    expect(claims).toMatch(/FROM insurance_preauth_responses\s+WHERE tenant_id = \$2::uuid/);
  });

  it('persists composite patient ownership and immutable claim money evidence', () => {
    const migration = source('../../migrations/753_pharmacy_order_inventory_authority.sql');
    const uniqueIndex = migration.indexOf('ux_insurance_policies_claim_authority_753');
    const compositeFk = migration.indexOf('fk_insurance_preauth_policy_authority_753');

    expect(uniqueIndex).toBeGreaterThan(-1);
    expect(compositeFk).toBeGreaterThan(uniqueIndex);
    expect(migration).toMatch(/fk_tpa_claim_preauth_authority_753/);
    expect(migration).toMatch(/fk_tpa_claim_invoice_authority_753/);
    expect(migration).toMatch(/enforce_insurance_preauth_authority_753/);
    expect(migration).toMatch(/enforce_tpa_claim_authority_753/);
    expect(migration).toMatch(/NEW\.total_billed IS DISTINCT FROM OLD\.total_billed/);
    expect(migration).toMatch(/NEW\.claimed_amount IS DISTINCT FROM OLD\.claimed_amount/);
    expect(migration).toMatch(/claim invoice is not bound to the exact patient and admission/);
  });
});
