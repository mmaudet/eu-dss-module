/**
 * selfTest.ts — End-to-end signing loop helper for the onboarding wizard.
 *
 * Uses a .txt payload instead of a PDF because the backend routes format purely
 * by extension: endsWith(".pdf") → PAdES, everything else → ASiC-E which wraps
 * arbitrary bytes. A .txt therefore needs no valid-PDF structure and exercises
 * the same prepare/sign/assemble/validate loop as a real document.
 *
 * Mirrors the signOne flow in components/SignWorkspace.tsx exactly.
 * Persists nothing — the signed bytes exist only in memory during the call.
 */

import { agentApi } from './agentApi';
import { backendApi } from './backendApi';
import { fileToBase64 } from './fileUtils';

export interface SelfTestCert {
  keyId: string;
  certificateChainBase64: string[];
  subjectDn: string;
}

export interface SelfTestResult {
  ok: boolean; // true iff all four steps succeeded AND signatureCount >= 1
  steps: { prepare: boolean; sign: boolean; assemble: boolean; validate: boolean };
  indication?: string;       // signatures[0]?.indication — informational, does NOT gate ok
  signatureCount?: number;
  failedStep?: 'prepare' | 'sign' | 'assemble' | 'validate';
  error?: string;            // message of the throw that stopped the run
}

/**
 * Run the full signing loop against a throwaway internal document.
 *
 * Assumes the card is ALREADY unlocked — the wizard handles PIN entry/unlock
 * before calling this function. Persists nothing.
 */
export async function runSelfTest(cert: SelfTestCert): Promise<SelfTestResult> {
  const steps = { prepare: false, sign: false, assemble: false, validate: false };

  // Build the test document exactly as a real user would supply a file.
  const payload = new File(
    ["EU-DSS — auto-test interne. Ce document n'est jamais conservé."],
    'eudss-selftest.txt',
    { type: 'text/plain' },
  );
  const fileName = payload.name;
  const documentBase64 = await fileToBase64(payload);

  // Signature params mirror signOne in SignWorkspace.tsx exactly.
  const params = {
    certificateChainBase64: cert.certificateChainBase64,
    digestAlgorithm: 'SHA256' as const,
    signingTimeEpochMs: Date.now(),
    signatureLevel: 'BASELINE_T' as const,
    signerName: cert.subjectDn,
  };

  let signatureCount: number | undefined;
  let indication: string | undefined;

  try {
    // Step 1 — prepare
    const prepared = await backendApi.prepare(documentBase64, fileName, params);
    steps.prepare = true;

    // Step 2 — sign (card must already be unlocked)
    const { signatureValueBase64 } = await agentApi.signDigest(
      cert.keyId,
      prepared.dataToSignDigestBase64,
      'SHA256',
    );
    steps.sign = true;

    // Step 3 — assemble
    const assembled = await backendApi.assemble(documentBase64, fileName, params, signatureValueBase64);
    steps.assemble = true;

    // Step 4 — validate
    const report = await backendApi.validate(assembled.signedDocumentBase64);
    steps.validate = true;

    signatureCount = report.signatureCount;
    indication = report.signatures[0]?.indication;
  } catch (e) {
    const failedStep = !steps.prepare
      ? 'prepare'
      : !steps.sign
      ? 'sign'
      : !steps.assemble
      ? 'assemble'
      : 'validate';

    return {
      ok: false,
      steps,
      failedStep,
      signatureCount,
      indication,
      error: (e as Error).message,
    };
  }

  const ok =
    steps.prepare && steps.sign && steps.assemble && steps.validate && (signatureCount ?? 0) >= 1;

  return { ok, steps, indication, signatureCount };
}
