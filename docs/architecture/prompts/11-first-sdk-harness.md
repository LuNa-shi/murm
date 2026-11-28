# First SDK Harness prompts

## Candidate Publisher Profile

The Harness supplies the fresh reference in the Publisher FileTree. This Profile can only publish a handoff.

Body SHA-256: `13a34f145feb381c6fd3f6f08be0a4fbacdd0c5f91a50f94e9561d88d5c878f6`

````text
Read release-data.txt. Publish its reference and one short question asking the user for a release channel. Run swarm service invoke handoff publish --help for arguments. Use the workspace for reading files.
````
## Candidate Writer Profile

The Writer receives the initial project FileTree and can take the handoff. The reference itself reaches the Writer through the Service.

Body SHA-256: `3a0542d4cd34195627be5c8452929e2c379ceaba4be7bb1b689bb7c3d9d508ed`

````text
Run swarm service invoke handoff take using the exact Bash command supplied in your task. Use the bash tool in your writable workspace. The command reads the reference from the Service and writes delivery.txt with two newline-terminated lines.
````
## Candidate Publisher follow-up

runInput calls Runtime.send after verifying the Publisher is idle. The first field is the original Run prompt.

Body SHA-256: `c9cb6fe483bcc179012d7c4686fd64edab618684813b4107e0d93423942ac400`

````text
<ORIGINAL_USER_PROMPT> Read the reference in release-data.txt. Publish the real reference with --reference=<reference> and --question=<quoted text> or use JSON on stdin. Use request ID publish-release. Finish when the handoff succeeds.
````
## Candidate Writer follow-up

The Harness interpolates channel after validating the reply from the current Session question or the configured noninteractive channel. runInput sends it to the spawned Writer.

Body SHA-256: `3bdfc8f4fbf64d1e68042f5695ccf3dd7faf20a3c663086b357e9d0d1b042d22`

````text
The user chose channel ${channel}. Run the following exact command with the bash tool in your workspace:
swarm service invoke handoff take --request-id take-release | node -e 'const { reference } = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log("reference=" + reference); console.log("channel=${channel}");' > delivery.txt
Finish when the command succeeds.
````
## Released v0.2.0 Publisher Profile

The host registers this read-only Profile. The unique reference is in release-data.txt in the publisher workspace.

Body SHA-256: `13a34f145feb381c6fd3f6f08be0a4fbacdd0c5f91a50f94e9561d88d5c878f6`

````text
Read release-data.txt. Publish its reference and one short question asking the user for a release channel. Run swarm service invoke handoff publish --help for arguments. Use the workspace for reading files.
````
## Released v0.2.0 Writer Profile

The host registers this writable Profile. The writer gets the reference and question from the permitted Service.

Body SHA-256: `3a0542d4cd34195627be5c8452929e2c379ceaba4be7bb1b689bb7c3d9d508ed`

````text
Run swarm service invoke handoff take using the exact Bash command supplied in your task. Use the bash tool in your writable workspace. The command reads the reference from the Service and writes delivery.txt with two newline-terminated lines.
````
## Handoff Service discovery

Startup discovery includes the purpose and the description for the operation granted to that Agent.

Body SHA-256: `2af91916af6e49afba4011936d9f8a229110c909f4d6e311a6eaa63f0012a800`

````text
Publish a reference and a user question for the next Agent.
Save the release reference and ask the user for a channel.
Fetch the reference and question together.
````
## Released v0.2.0 Publisher follow-up

The host sends this text after successfully spawning the publisher.

Body SHA-256: `ebe08f19056c1be118630190874287e60c402137082a422ebd4e2ce405083d3a`

````text
Read the reference in release-data.txt. Optional diagnostic: first attempt to publish with numeric reference 123 and observe the schema rejection, then correct it. Publish the real reference with --reference=<reference> and --question=<quoted text> or use JSON on stdin. Use request ID publish-release for the corrected call. Finish when the handoff succeeds.
````
## Released v0.2.0 Writer follow-up

The host interpolates channel from its terminal reader after restricting it to a lowercase channel identifier, then starts the writer and sends this input.

Body SHA-256: `3bdfc8f4fbf64d1e68042f5695ccf3dd7faf20a3c663086b357e9d0d1b042d22`

````text
The user chose channel ${channel}. Run the following exact command with the bash tool in your workspace:
swarm service invoke handoff take --request-id take-release | node -e 'const { reference } = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log("reference=" + reference); console.log("channel=${channel}");' > delivery.txt
Finish when the command succeeds.
````
