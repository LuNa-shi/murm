export const diagnosticFilename = 'kimi-tool-diagnostic.txt';
export const diagnosticMarker = 'KIMI_TOOL_CONTINUATION_MARKER';
export const diagnosticInput = `Use exactly one Bash tool call to run printf '%s\\n' '${diagnosticMarker}' > '${diagnosticFilename}' and then cat '${diagnosticFilename}' in that same Bash call. Do not call any other tool. After that tool returns, reply briefly DIAGNOSTIC_OK. Do not print credentials or inspect environment/configuration.`;

export function verifyDiagnosticBounds(receipt) {
  if (!receipt || receipt.maxRequests !== 2 || receipt.maxConcurrent !== 1 || receipt.maxOutputTokens !== 512 || receipt.maxAggregateOutputTokens !== 1024 ||
      receipt.maxInputBytes !== 131072 || receipt.maxAggregateInputBytes !== 262144 || !Number.isSafeInteger(receipt.forwarded) || receipt.forwarded < 1 || receipt.forwarded > 2 ||
      receipt.peakConcurrent > 1 || receipt.requests?.length !== receipt.forwarded) return false;
  const rows = receipt.requests;
  return rows.every(row => Number.isSafeInteger(row.maxOutputTokens) && row.maxOutputTokens > 0 && row.maxOutputTokens <= 512 &&
    Number.isSafeInteger(row.inputBytes) && row.inputBytes > 0 && row.inputBytes <= 131072 && (row.status !== 'complete' ||
      (Number.isSafeInteger(row.usage?.inputTokens) && row.usage.inputTokens >= 0 && Number.isSafeInteger(row.usage?.outputTokens) && row.usage.outputTokens >= 0 && row.usage.outputTokens <= row.maxOutputTokens))) &&
    receipt.reservedOutputTokens === rows.reduce((sum, row) => sum + row.maxOutputTokens, 0) && receipt.reservedOutputTokens <= 1024 &&
    receipt.reservedInputBytes === rows.reduce((sum, row) => sum + row.inputBytes, 0) && receipt.reservedInputBytes <= 262144;
}

// Diagnostic findings are distinct from cooperation acceptance. Never infer
// compatibility from a model claim, a first response or a local cap rejection.
export function classifyToolDiagnostic({ receipt, result, fileVerified }) {
  const second = receipt?.requests?.[1];
  const boundary = receipt?.forwarded === 2 && receipt.bashReturned === true;
  const geometry = second?.geometry;
  const geometryAvailable = geometry !== undefined;
  if (!boundary || !fileVerified || receipt.deadlineReached ||
      geometry?.functionCalls !== 1 || geometry.functionCallOutputs !== 1 || geometry.callIdsMatched !== true) return { status: 'uninformative', geometryAvailable };
  if (second.status === 'rejected' && second.statusCode === 400 && receipt.failure?.number === 2 && result?.kind === 'failed') {
    return { status: 'provider_rejected', geometryAvailable, rejection: second.rejection };
  }
  if (!receipt.rejectedArrivals && second.status === 'complete' && second.terminal === 'response.completed' && result?.kind === 'completed' && result.outcome === 'completed') {
    return { status: 'compatible', geometryAvailable };
  }
  return { status: 'uninformative', geometryAvailable };
}
