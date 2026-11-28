# OpenSandbox Kubernetes deployment

This profile uses the official OpenSandbox 1.2.1 umbrella chart at `db708c218771a8d311356f0e96552c15df6e097a`. It deploys ordinary BatchSandbox Pods behind the official Ingress gateway. The Lifecycle Server has one replica, the gateway has two, and the murm Runtime has one. Kubernetes places Agent Pods on nodes selected by the operator.

The implementation is tracked in [#273](https://github.com/LuNa-shi/murm/issues/273) and depends on [#272](https://github.com/LuNa-shi/murm/issues/272). Cluster acceptance and capacity measurements are `not-run` in this checkout. Running the 2/8/32/128/1,024 tiers requires the owner's explicit experiment approval. Rendering these manifests allocates no cluster resources.

## Prerequisites

Use Node.js 22.19+, Git, Helm 3.x, and `kubectl` authenticated to an existing cluster. The upstream chart accepts Kubernetes 1.21.1+. Record the actual cluster, container runtime, CNI, CSI and kernel versions before validation. At least two distinct worker VM or host instances are required for multi-node acceptance. Two containers serving as Kubernetes nodes establish a CI topology observation.

Prepare a StorageClass with persistent volumes available to the Server and Runtime. Review its access mode, node attachment, reclaim and fencing behavior. `ReadWriteOnce`, a one-replica Deployment, or SQLite alone supplies no proof that a Controller on an unreachable node has lost control of the Lifecycle API. The application recovery entry point must require its ownership and fencing evidence before resuming effects.

The CNI must implement the chosen network policy, and the workload namespace admission policy must permit OpenSandbox's egress sidecar to use its required `NET_ADMIN` capability. Verify the pinned upstream security requirements against the cluster's policy. The profile uses `dns+nft`; packet denial still requires the deployment probes in #272/#273.

Build and push matching Worker and application Runtime images under an authorized release process. Pin both registry digests in the site file. The Runtime image must contain the installed murm package, the application's Harness bootstrap/reconstruction code and its trusted configuration reader. Its entry point must read `/etc/murm/config.json`, use `/var/lib/murm` as persistent run storage, set `sandbox.egressMode` to `dns+nft`, bind the callback with `connection.bindHost` = `0.0.0.0` and `connection.bindPort` = `3100`, and consume the connection environment supplied by the Deployment. The application selects `createRuntime` for a new run or the public recovery entry point for an existing run with the required Service reconstruction contract.

The fixed Pod resource requests are initial deployment reservations, with explicit limits. They are configuration defaults awaiting measurement. Set Agent requests/limits in the application Sandbox configuration and record the resulting Pod resources in each test manifest. Account for the Worker, executor, Execd installer, egress sidecar, image/cache and workload storage. Capacity declarations require actual peak and sustained measurements.

## Prepare private deployment inputs

Copy `site.example.json` outside the source tree and replace every placeholder. Use an image reference containing `@sha256:` for the Worker and Runtime. Select prepared worker nodes with `sandboxNodeSelector`. Identify the installed CNI Pods with `cniNamespace` and `cniSelector`, and, when CSI is installed, its driver Pods with `csiNamespace` and `csiSelector`. Set `csiSelector` to `null` when storage uses an in-tree or non-CSI provisioner. Inventory verifies this against installed driver definitions and records the StorageClass provisioner.

The example uses authenticated HTTP over an explicitly trusted private cluster network. `gatewayAddress` is a private address without scheme or path, following the pinned upstream schema. Both Server announcement and gateway use URI routing and the same signing Secret. The Runtime callback is the stable internal Service address `http://murm-runtime.murm.svc.cluster.local:3100`. The Lifecycle URL is `http://opensandbox-server.opensandbox-system.svc.cluster.local`. Controller-to-Worker traffic traverses the announced signed gateway route, and Pods call the one Runtime Service.

For external access, have the infrastructure operator supply authenticated TLS termination, reachable DNS, matching gateway announcement and certificate trust in both Controller and guest images. Preserve all endpoint route headers. Verify the endpoint scheme returned and selected by the SDK against that actual deployment. The included profile requires the private network declaration and fails when that condition is absent. It does not automatically create public LoadBalancer services or certificates.

```sh
node deploy/opensandbox-kubernetes/prepare.mjs /secure/site.json experiments/cluster-render
PATH=/path/to/helm/bin:$PATH \
  deploy/opensandbox-kubernetes/chart.sh experiments/opensandbox-source experiments/cluster-render
```

`prepare.mjs` validates the site, produces JSON accepted by Kubernetes and Helm, and writes files with mode 0600 in a mode 0700 directory. `chart.sh` checks out the exact upstream commit, rejects tracked edits or a different commit, packages local chart dependencies, lints and renders the chart. It checks image digest pins, gateway routing/signing, dns+nft and the ordinary-Pod profile. It needs network access for the initial source fetch. The chart dependency build uses the pinned checkout's sibling charts. No Helm repository URL is required.

The prepared files are `values.json`, `resources.json`, `chart.yaml`, and `manifest-inputs.json`. The latter records source and configuration hashes, image references, listener and persistence locations. Keep these files private when site metadata is sensitive.

## Provision Secrets and install

Use the existing cluster's authorized deployment workflow. Review the rendered files before applying them. The following commands change the selected cluster.

```sh
kubectl apply -f experiments/cluster-render/resources.json
```

Create the following Secrets through your existing secret manager or from local protected files. The same Lifecycle API key must be present in both namespaces. No key belongs in the site file, ConfigMap, Git, or a command-line literal.

| Namespace | Secret name from site file | Keys |
| --- | --- | --- |
| `opensandbox-system` | `apiKeySecret` | `api-key` |
| `murm` | `apiKeySecret` | `api-key` with the same value |
| `opensandbox-system` | `signingKeySecret` | `keys` and `active-key` |
| `murm` | `runtimeConfigSecret` | `config.json` and any application-managed configuration files |

The signing Secret follows the upstream key-ring contract. `active-key` contains a single lower-case alphanumeric key ID such as `a`. `keys` contains `a=<base64-secret>`, with a randomly generated signing secret of the size required by OpenSandbox. Create these files through the secret manager. The Server reads the active key and key ring through environment references. The gateway reads the same ring. Rotating an existing signing Secret requires a coordinated Server and gateway rollout because both read it at startup.

For example, with the default Secret names and already protected files, use file references. Invoke each command for the matching namespace and ensure your shell pipeline propagates errors.

```sh
kubectl create secret generic opensandbox-api-key -n opensandbox-system \
  --from-file=api-key=/secure/opensandbox-api-key
kubectl create secret generic opensandbox-api-key -n murm \
  --from-file=api-key=/secure/opensandbox-api-key
kubectl create secret generic opensandbox-signing-keys -n opensandbox-system \
  --from-file=keys=/secure/opensandbox-signing-keys \
  --from-file=active-key=/secure/opensandbox-active-key
kubectl create secret generic murm-runtime-config -n murm \
  --from-file=config.json=/secure/murm-config.json
helm upgrade --install opensandbox experiments/opensandbox-source/manifests/charts/opensandbox \
  --namespace opensandbox-system --values experiments/cluster-render/values.json \
  --wait --timeout 10m
kubectl rollout status deployment/murm-runtime -n murm --timeout=5m
```

The initial resource apply creates the Runtime Deployment, which waits until its required Secrets and the infrastructure exist. An application bootstrap that sees an existing run must execute its recovery procedure. It must not initialize a new run merely because the previous Pod died. Keep the same stable callback and run directory on restarts. An independent retained-resource maintenance process must acquire the same exclusive ownership before acting.

The Server SQLite volume is mounted at `/var/lib/opensandbox`; Runtime state is at `/var/lib/murm`. The Server's Recreate rollout stops the old Server before starting the replacement. An interrupted Lifecycle request remains subject to resource reconciliation. Use the Server's ordinary Kubernetes RBAC and API configuration through the chart. The Runtime Pod has no Kubernetes service-account token mounted and uses only the authenticated OpenSandbox API.

## Inspect and validate

```sh
node deploy/opensandbox-kubernetes/inspect.mjs /secure/site.json experiments/cluster-inventory
```

This read-only command has a 30-second per-command deadline and bounded output. It stores raw inventories privately, checks two Ready selected nodes with distinct machine identities, verifies the one-Server/two-gateway/one-Runtime topology, and records actual Kubernetes, kubelet, runtime, CNI and CSI image IDs, CSI driver definitions and storage configuration. It fails if required queries or observations are unavailable. Keep the node and Pod inventories private. Attach independent VM/host-instance evidence to establish the required physical topology. The generated summary leaves connectivity, isolation and capacity marked `not-run`.

Run `murm doctor --smoke` inside the configured Runtime environment, or from a Controller with the same private network routes and trusted configuration. Confirm all three chains through the normal SDK paths.

1. Authenticated Controller access to the Lifecycle API.
2. Controller access to the Worker through the exact announced gateway URL and headers.
3. Sandbox access to Runtime Bridge, Model Gateway and authorized Services, including file export and verified deletion.

A successful Lifecycle list alone is preflight evidence. The explicit smoke makes guest-originated Service and controlled-model requests. Run the full small two-Agent Pi and Codex probes before the cluster scale protocol. Packet policy tests must check allowed IP/port, forbidden destination/port, another Sandbox and the non-loopback management address independently from credential-denial tests.

## Upgrade, diagnose and uninstall

Render every upgrade into a fresh private directory and retain its manifest hashes. Check that Worker protocol and executor versions match the installed Controller. An infrastructure upgrade should stop input admission, persist closing or recovery intent as appropriate, and preserve the ledger and ownership. Expect a short Lifecycle API interruption during the single-active Server rollout. After rollout, re-run inventory and bidirectional smoke, then reconcile pending resources on their original deployment before accepting new work.

Inspect `kubectl get pods -n opensandbox-system`, `kubectl get batchsandboxes -n opensandbox`, and `kubectl get pvc -A`. Store full Pod descriptions, node identities, application state, stdout/stderr and logs only in ignored private evidence directories. Look for image pulls, scheduling requests/limits, unavailable storage attachments, gateway key/route mismatch, DNS, egress capability denial and callback reachability. A platform deny rule can block a legitimate application target. Preserve that diagnosis and adjust the reviewed policy or target through the operator workflow.

Before uninstall, persist Runtime closing intent, complete required exports, and independently reconcile every recorded allocation and every matching Sandbox/Pod. An unreachable node can still hold a running process even after API objects disappear. Keep unknown allocations and capacity until execution stop is confirmed or trusted infrastructure fencing proves termination.

Once ownership is resolved, remove the application Runtime Deployment and uninstall the exact `opensandbox` Helm release. The profile keeps PVCs and the upstream chart keeps CRDs. Operators retain responsibility for external volumes, the two PVCs, Secrets and namespaces. Verify the storage reclaim policy before any explicit PVC/PV deletion. Delete namespaces or shared CRDs only after independently confirming that other runs and deployments do not depend on them.

## Version provenance

`bom.json` records registry manifest digests fetched for the fixed upstream release. Each deployment manifest adds its selected Worker and Runtime digests and records installed infrastructure versions. The upstream chart itself remains at the exact source commit. See the [pinned upstream deployment manual](https://github.com/opensandbox-group/OpenSandbox/blob/db708c218771a8d311356f0e96552c15df6e097a/docs/deployment/index.md) for component contracts and the [pinned API schema](https://github.com/opensandbox-group/OpenSandbox/blob/db708c218771a8d311356f0e96552c15df6e097a/server/opensandbox_server/api/schema.py) for supported requests and limits.

The [capacity runner](../../benchmarks/kubernetes/README.md) provides one approved-manifest workflow for all five Agent tiers. Its default is a `not-run` plan; `--execute` requires a hash-bound owner approval and independent VM/inventory preflight. Workload success alone does not complete the fault matrix or authorize a capacity claim.
