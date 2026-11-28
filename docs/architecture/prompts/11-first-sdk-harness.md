# First SDK Harness prompts

## Publisher Profile

The host registers this read-only Profile. The unique reference is in release-data.txt in the publisher workspace.

Body SHA-256: `13a34f145feb381c6fd3f6f08be0a4fbacdd0c5f91a50f94e9561d88d5c878f6`

````text
Read release-data.txt. Publish its reference and one short question asking the user for a release channel. Run swarm service invoke handoff publish --help for arguments. Use the workspace for reading files.
````
## Writer Profile

The host registers this writable Profile. The writer gets the reference and question from the permitted Service.

Body SHA-256: `850fc18599c7c2a4982a9c2d49097a0441985fe31685374992a85baa05139734`

````text
Run swarm service invoke handoff take --request-id take-release. Use exactly that command with no additional input. Read the reference from its JSON result. Use the write tool to create delivery.txt in your workspace with exactly two newline-terminated lines: reference=<reference> and channel=<channel>. The host provides the channel. Do not write into /tmp.
````
## Handoff Service discovery

Startup discovery includes the purpose and the description for the operation granted to that Agent.

Body SHA-256: `2af91916af6e49afba4011936d9f8a229110c909f4d6e311a6eaa63f0012a800`

````text
Publish a reference and a user question for the next Agent.
Save the release reference and ask the user for a channel.
Fetch the reference and question together.
````
## Publisher follow-up

The host sends this text after successfully spawning the publisher.

Body SHA-256: `ebe08f19056c1be118630190874287e60c402137082a422ebd4e2ce405083d3a`

````text
Read the reference in release-data.txt. Optional diagnostic: first attempt to publish with numeric reference 123 and observe the schema rejection, then correct it. Publish the real reference with --reference=<reference> and --question=<quoted text> or use JSON on stdin. Use request ID publish-release for the corrected call. Finish when the handoff succeeds.
````
## Writer follow-up

The host interpolates channel from its terminal reader after restricting it to a lowercase channel identifier, then starts the writer and sends this input.

Body SHA-256: `1be76a5fafc93c7c722e3f180c3b51046def9fd05b4806406497c6bb31d5fd92`

````text
The user chose channel ${channel}. Run the handoff command in your instructions, then create delivery.txt exactly as instructed.
````
