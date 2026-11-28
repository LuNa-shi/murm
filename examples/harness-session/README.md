# HarnessSession clients

This deterministic example defines one custom `Harness` and consumes it
through the package-root SDK, typed JSONL RPC client and a text terminal. It
captures a supplied project, asks two independent business questions, records
subsequent text input, and saves answers before returning its cleanup result.
It demonstrates the protocol with local work and zero Runtimes. See [first-harness](../../docs/en/first-harness.md) for a publisher and writer exchanging data through a real Service and exporting a verified result.

Copy this directory outside the checkout, install the candidate SDK archive,
and build it. The archive must include the HarnessSession API from Issue #271.

```sh
npm install --no-save /absolute/path/to/luna-shi-murm-0.2.0.tgz
npm run check
npm run build
npm run sdk -- /absolute/path/to/project 'Run the direct SDK example'
npm run rpc -- /absolute/path/to/project 'Run the RPC example'
npm start -- /absolute/path/to/project 'Ask me the two business questions'
```

The SDK and RPC programs answer both questions and send a subsequent input
before stopping. Each prints the final result, including artifact export and
cleanup. The terminal prints current state, output and questions. Enter text
to submit input, `/status` to refresh state, `/answer name "Ada"` and
`/answer confirm true` to answer the example questions, and `/stop` to finish.
