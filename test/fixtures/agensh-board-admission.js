// Locally authored PATCH_SUMMARY-only admission oracle for the command regression.
// Contract checked independently against native verifier.py at Agensh revision
// 2dae4e14a653da48549fd9aa093f834841475d6c, not a replacement Board implementation.
// https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/board-service/verifier.py
export function admitPatchSummary(note) {
  if (String(note.type).trim().toUpperCase() !== 'PATCH_SUMMARY') throw new Error('Oracle only accepts PATCH_SUMMARY');
  // Native admission evaluates the stored, capped gist rather than long detail.
  const stored = String(note.content ?? '').trim().slice(0, 300);
  const field = stored.split('|').find(part => part.trim().toLowerCase().startsWith('evidence='));
  const evidence = field?.trim().slice('evidence='.length).trim() ?? '';
  const placeholder = /^(?:tbd|pending|not verified|unverified|should work|should pass|looks right|looks correct|seems to work|to be verified|will verify|n\/a)(?:$|[^a-z])/i;
  return { status: evidence && !placeholder.test(evidence) ? 'admitted' : 'rejected' };
}
