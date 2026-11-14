# 10. Complete Service and capability reference

This is the exact repository-controlled API declaration inventory for the implementation pinned in [Architecture INDEX](INDEX.md). It is meant to be read with [04 Services](04-services.md): the declarations say which fields are advertised, while the narrative explains how requests actually change durable state, when Runtime intervenes, and what failures mean.

A JSON Schema in a manifest is a declared contract. This implementation validates manifest shape at registration and passes input schemas to Pi, but the Registry/HTTP host do **not** run a general JSON Schema validator on every input or output. Domain handlers perform their own validation. In particular, an empty Runtime output schema or the built-in “any JSON value” output schema is not a complete description of the result. The narrative and storage reference supply the missing implementation detail.

## How to read an entry

| Field | Meaning in this implementation |
|---|---|
| `name` / `operation` | Named capability and dispatched handler operation. The Pi tool name is `swarmenv_` followed by the profile's disambiguated `tool_name`. |
| `audience` | Which Session roles may see/call it; currently `bound` and `recovery`. |
| `context` | Context needed by Bridge; non-catalog registered operations with nonempty context normally require a current Task/Execution, except taking a Task. |
| `requires_binding` | Additional binding check enforced by Registry and HTTP host, used by Mathlib Search. |
| `idempotent` | Manifest declaration. Durable Task/Context replay uses the operation ID and entire request fingerprint; this flag alone does not implement replay. |
| `input_schema` / `output_schema` | Full advertised schemas, including required fields, unions, enums, limits and openness. |
| `help` | Complete registered usage text/ref. Whether the full text reaches a particular prompt is documented in [08 Prompts](08-prompts.md). |
| `errors` | Declared error list; built-in manifests use an empty list even though handlers can return domain errors. The complete shared vocabulary is reproduced below. |
| `method` / `path` | HTTP route for a hosted provider. In-process adapters use the same capability identity without an HTTP request. |

## Updating this reference

After changing catalogs, capability selection, manifests, schemas or error vocabulary, run `node scripts/generate-architecture-api.mjs` and review the generated differences. `node scripts/generate-architecture-api.mjs --check` detects stale generated content without changing it. A successful check detects declaration drift; it does not prove that the explanatory text or runtime behavior is correct.

<!-- BEGIN GENERATED REFERENCE -->

## Generated API inventory

This section is generated from executable exports and checked against the source hashes below. It contains declarations; call-time behavior and known differences are explained in [Services](04-services.md), [Mission and Task](03-mission-task.md), and [Workspace](05-workspace-continuity.md).

| Source | SHA-256 |
|---|---|
| [src/sdk/service-catalog.js](../../src/sdk/service-catalog.js) | `5b61e34dd15738d4d3cbcaf3863c8b4f8b6c767f3ad01fedd1021e9430775da5` |
| [src/sdk/builtin-registry.js](../../src/sdk/builtin-registry.js) | `f32535685b3f964092ae65c62c2a58d8a2cd1721abe7775fc7a6599bf13c17f6` |
| [src/sdk/service-manifest.js](../../src/sdk/service-manifest.js) | `415bf40c46e284fbd5ad52fc5f7c96266003edb5573dba3a55c734966b9e01bf` |
| [src/sdk/service-registry.js](../../src/sdk/service-registry.js) | `6528826cb1e89980159bc23150e6f18162df54ac3f9eb5eda264befb6160dc46` |
| [src/agent/capability-profile.js](../../src/agent/capability-profile.js) | `fb811cb2c59cc4390357dbb072cff0f842fdb537e0bd020f9cc5e56ff74094af` |
| [src/agent/services-bridge.js](../../src/agent/services-bridge.js) | `6ec040f3b59bcd6205733bca1173e58a67e3fac4bb22f2fb76b898bcfe314163` |
| [src/sdk/services-sdk.js](../../src/sdk/services-sdk.js) | `778e951a2f200b788658de6f7cb8e5e06696035745fa35406d9960457c8c5089` |
| [src/sdk/service-router.js](../../src/sdk/service-router.js) | `1b75bcdc0833c4690709f0120d01c3e71cf0c4f4d61ffe6125f5202110055bbd` |
| [src/runtime/runtime-capabilities.js](../../src/runtime/runtime-capabilities.js) | `e53aef2c60ef61eccbefdb05135958803f1c100b7505de5abe75103f7e2e8d05` |
| [src/benchmark/putnam-runner.js](../../src/benchmark/putnam-runner.js) | `16970e7a08508db64c320120aaa102dbe4d93962cd3d1c68aad5ed46cb7210fc` |
| [services/mathlib-search/service.json](../../services/mathlib-search/service.json) | `616a349bea3dc7282f26a90a3c8882d06afe846c58fdbf00a851404546c15b70` |
| [src/errors.js](../../src/errors.js) | `eedbc3e6869e525c16369ca1aca042d12bdc0877a3f4447be4319f23e54e3ddc` |

### Exact tool exposure for the built-in benchmark

The four columns apply the benchmark's current Task-model and Sandbox filters. Optional registered Services add capabilities. Both built-in `bound` and `recovery` roles currently have the same named surface. Presence in this table does not bypass the Bridge's Task/Execution binding, modern-retired-operation or Workspace-contract checks. `swarmenv_` is the Pi extension prefix.

| Capability identity | flat; Sandbox off | flat; Sandbox on |
|---|---|---|
| `catalog.catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` |
| `catalog.catalog_list_services` | `swarmenv_catalog_list_services` | `swarmenv_catalog_list_services` |
| `catalog.catalog_list_tools` | `swarmenv_catalog_list_tools` | `swarmenv_catalog_list_tools` |
| `context.context_consume` | `swarmenv_context_consume` | `swarmenv_context_consume` |
| `context.context_get_material` | `swarmenv_context_get_material` | `swarmenv_context_get_material` |
| `context.context_publish` | `swarmenv_context_publish` | `swarmenv_context_publish` |
| `context.context_publish_material` | `swarmenv_context_publish_material` | `swarmenv_context_publish_material` |
| `context.context_read` | `swarmenv_context_read` | `swarmenv_context_read` |
| `context.context_search_materials` | `swarmenv_context_search_materials` | `swarmenv_context_search_materials` |
| `judge.judge_get_check_result` | `swarmenv_judge_get_check_result` | `swarmenv_judge_get_check_result` |
| `judge.judge_workspace_check` | `swarmenv_judge_workspace_check` | `swarmenv_judge_workspace_check` |
| `runtime.execution_get` | `swarmenv_execution_get` | `swarmenv_execution_get` |
| `runtime.sandbox_exec` | Absent | `swarmenv_sandbox_exec` |
| `runtime.sandbox_job` | Absent | `swarmenv_sandbox_job` |
| `runtime.workspace_diff` | `swarmenv_workspace_diff` | `swarmenv_workspace_diff` |
| `runtime.workspace_get` | `swarmenv_workspace_get` | `swarmenv_workspace_get` |
| `runtime.workspace_list_files` | `swarmenv_workspace_list_files` | `swarmenv_workspace_list_files` |
| `runtime.workspace_read_file` | `swarmenv_workspace_read_file` | `swarmenv_workspace_read_file` |
| `runtime.workspace_write_file` | `swarmenv_workspace_write_file` | `swarmenv_workspace_write_file` |
| `task.execution_progress` | `swarmenv_execution_progress` | `swarmenv_execution_progress` |
| `task.mission_submission_get` | `swarmenv_mission_submission_get` | `swarmenv_mission_submission_get` |
| `task.mission_submit` | `swarmenv_mission_submit` | `swarmenv_mission_submit` |
| `task.task_create` | `swarmenv_task_create` | `swarmenv_task_create` |
| `task.task_feedback` | `swarmenv_task_feedback` | `swarmenv_task_feedback` |
| `task.task_finish` | `swarmenv_task_finish` | `swarmenv_task_finish` |
| `task.task_link_material` | `swarmenv_task_link_material` | `swarmenv_task_link_material` |
| `task.task_list` | `swarmenv_task_list` | `swarmenv_task_list` |
| `task.task_status` | `swarmenv_task_status` | `swarmenv_task_status` |
| `task.task_take` | `swarmenv_task_take` | `swarmenv_task_take` |
| `task.task_view` | `swarmenv_task_view` | `swarmenv_task_view` |
| `task.workspace_merge` | `swarmenv_workspace_merge` | `swarmenv_workspace_merge` |
| `task.workspace_public_apply` | `swarmenv_workspace_public_apply` | `swarmenv_workspace_public_apply` |
| `task.workspace_public_files` | `swarmenv_workspace_public_files` | `swarmenv_workspace_public_files` |
| `task.workspace_public_read` | `swarmenv_workspace_public_read` | `swarmenv_workspace_public_read` |
| `task.workspace_public_search` | `swarmenv_workspace_public_search` | `swarmenv_workspace_public_search` |
| `task.workspace_save` | `swarmenv_workspace_save` | `swarmenv_workspace_save` |

The flat Mission Task profile is the only Agent-facing Task model. Retired structural and lease operations may remain in internal catalog definitions for storage/analysis compatibility, but are filtered from the built-in Registry and cannot be called by a bound Agent. The normal handoff tool is `execution_progress` with `kind: "handoff"`.

### Service Catalog: 3 registered capabilities

Exact normalized built-in manifest metadata:

```json
{
  "manifest_version": "1",
  "service_id": "catalog",
  "id": "catalog",
  "title": "Service Catalog",
  "purpose": "Role-scoped Service and capability discovery.",
  "provider_version": "builtin-1",
  "contract_version": "1",
  "endpoint": {
    "transport": "in-process"
  },
  "metadata": {},
  "health": {
    "path": "/healthz"
  },
  "readiness": {
    "path": "/readyz"
  },
  "manifest_hash": "7b0c87da8e05f7468364705ec0b8ec7277df9e49141f4d1fefca9711fe54a86c"
}
```

#### catalog.catalog_list_services

List every available SwarmEnv Service and its tool count.

```json
{
  "name": "catalog_list_services",
  "operation": "list_services",
  "description": "List every available SwarmEnv Service and its tool count.",
  "input_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "public-read",
  "help": {
    "when": "List every available SwarmEnv Service and its tool count.",
    "ref": "service://catalog/list_services",
    "text": "Purpose: Role-scoped Service and capability discovery.\nUse when: List every available SwarmEnv Service and its tool count.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/list_services",
  "errors": []
}
```

#### catalog.catalog_get_service_metadata

Read one Service description and its complete named tool metadata.

```json
{
  "name": "catalog_get_service_metadata",
  "operation": "get_service_metadata",
  "description": "Read one Service description and its complete named tool metadata.",
  "input_schema": {
    "type": "object",
    "required": [
      "service"
    ],
    "properties": {
      "service": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "public-read",
  "help": {
    "when": "Read one Service description and its complete named tool metadata.",
    "ref": "service://catalog/get_service_metadata",
    "text": "Purpose: Role-scoped Service and capability discovery.\nUse when: Read one Service description and its complete named tool metadata.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/get_service_metadata",
  "errors": []
}
```

#### catalog.catalog_list_tools

List all named Service tools or only the tools owned by one Service.

```json
{
  "name": "catalog_list_tools",
  "operation": "list_tools",
  "description": "List all named Service tools or only the tools owned by one Service.",
  "input_schema": {
    "type": "object",
    "properties": {
      "service": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "public-read",
  "help": {
    "when": "List all named Service tools or only the tools owned by one Service.",
    "ref": "service://catalog/list_tools",
    "text": "Purpose: Role-scoped Service and capability discovery.\nUse when: List all named Service tools or only the tools owned by one Service.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/list_tools",
  "errors": []
}
```

### Task Service: 17 registered capabilities

Exact normalized built-in manifest metadata:

```json
{
  "manifest_version": "1",
  "service_id": "task",
  "id": "task",
  "title": "Task Service",
  "purpose": "Durable Task goals, takes, structure, and completion evidence.",
  "provider_version": "builtin-1",
  "contract_version": "1",
  "endpoint": {
    "transport": "in-process"
  },
  "metadata": {},
  "health": {
    "path": "/healthz"
  },
  "readiness": {
    "path": "/readyz"
  },
  "manifest_hash": "3e106ea3f47c23211cb41dcbb6b1e607bf7663f2a59fdfd649950d192f7cbf7b"
}
```

#### task.task_status

Read the authoritative Mission, Task counts, eligible work, and observation timestamp.

```json
{
  "name": "task_status",
  "operation": "task_status",
  "description": "Read the authoritative Mission, Task counts, eligible work, and observation timestamp.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "states": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-read",
  "help": {
    "when": "Read the authoritative Mission, Task counts, eligible work, and observation timestamp.",
    "ref": "service://task/task_status",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read the authoritative Mission, Task counts, eligible work, and observation timestamp.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_status",
  "errors": []
}
```

#### task.task_take

Take an existing Mission or ordinary Task using the caller identity and Core lane.

```json
{
  "name": "task_take",
  "operation": "task_take",
  "description": "Take an existing Mission or ordinary Task using the caller identity and Core lane.",
  "input_schema": {
    "type": "object",
    "required": [
      "task_id"
    ],
    "properties": {
      "task_id": {
        "type": "string"
      },
      "take_key": {
        "type": "string"
      },
      "input_material_refs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Take an existing Mission or ordinary Task using the caller identity and Core lane.",
    "ref": "service://task/task_take",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Take an existing Mission or ordinary Task using the caller identity and Core lane.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_take",
  "errors": []
}
```

#### task.task_feedback

Record this Execution's durable decision and action for delivered feedback; another Execution may retain its own handling state.

```json
{
  "name": "task_feedback",
  "operation": "task_feedback",
  "description": "Record this Execution's durable decision and action for delivered feedback; another Execution may retain its own handling state.",
  "input_schema": {
    "type": "object",
    "required": [
      "notification_id",
      "decision",
      "action"
    ],
    "properties": {
      "notification_id": {
        "type": "string"
      },
      "decision": {
        "type": "string"
      },
      "action": {
        "type": "string"
      },
      "details": {
        "type": "object"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Record this Execution's durable decision and action for delivered feedback; another Execution may retain its own handling state.",
    "ref": "service://task/task_feedback",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Record this Execution's durable decision and action for delivered feedback; another Execution may retain its own handling state.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_feedback",
  "errors": []
}
```

#### task.execution_progress

Save a bounded Progress Material and either continue the current Execution or hand it off.

```json
{
  "name": "execution_progress",
  "operation": "execution_progress",
  "description": "Save a bounded Progress Material and either continue the current Execution or hand it off.",
  "input_schema": {
    "type": "object",
    "required": [
      "kind",
      "progress"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "checkpoint",
          "handoff"
        ]
      },
      "progress": {
        "type": "object",
        "required": [
          "completed_work",
          "findings",
          "open_questions",
          "next_step"
        ]
      },
      "checkpoint": {
        "type": "object"
      },
      "files": {
        "type": "object"
      },
      "reason": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Save a bounded Progress Material and either continue the current Execution or hand it off.",
    "ref": "service://task/execution_progress",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Save a bounded Progress Material and either continue the current Execution or hand it off.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/execution_progress",
  "errors": []
}
```

#### task.task_list

List Mission Tasks and search their short summaries before proposing new work.

```json
{
  "name": "task_list",
  "operation": "task_list",
  "description": "List Mission Tasks and search their short summaries before proposing new work.",
  "input_schema": {
    "type": "object",
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "query": {
        "type": "string"
      },
      "state": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-read",
  "help": {
    "when": "List Mission Tasks and search their short summaries before proposing new work.",
    "ref": "service://task/task_list",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: List Mission Tasks and search their short summaries before proposing new work.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_list",
  "errors": []
}
```

#### task.task_view

Read one Task, its two relations, state, current Execution, and linked Materials.

```json
{
  "name": "task_view",
  "operation": "task_view",
  "description": "Read one Task, its two relations, state, current Execution, and linked Materials.",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-read",
  "help": {
    "when": "Read one Task, its two relations, state, current Execution, and linked Materials.",
    "ref": "service://task/task_view",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read one Task, its two relations, state, current Execution, and linked Materials.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_view",
  "errors": []
}
```

#### task.task_create

Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.

```json
{
  "name": "task_create",
  "operation": "task_create",
  "description": "Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id",
      "summary",
      "expected_output",
      "acceptance_conditions"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "goal": {
        "type": "string"
      },
      "task_type": {
        "type": "string"
      },
      "task_instructions": {
        "type": "string"
      },
      "expected_output": {
        "type": "string"
      },
      "acceptance_conditions": {
        "oneOf": [
          {
            "type": "array"
          },
          {
            "type": "object"
          }
        ]
      },
      "required_capabilities": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "completion_contract": {
        "type": "object"
      },
      "workspace": {
        "type": "object"
      },
      "input_material_refs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "responsibility_key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "priority": {
        "type": "integer",
        "minimum": 0
      },
      "spawned_from": {
        "type": "string"
      },
      "depends_on": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "timebox_ms": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.",
    "ref": "service://task/task_create",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_create",
  "errors": []
}
```

#### task.task_link_material

Link an immutable Material to a Task with an input, response, handoff, or experience role.

```json
{
  "name": "task_link_material",
  "operation": "task_link_material",
  "description": "Link an immutable Material to a Task with an input, response, handoff, or experience role.",
  "input_schema": {
    "type": "object",
    "required": [
      "task_id",
      "material_id",
      "role"
    ],
    "properties": {
      "task_id": {
        "type": "string"
      },
      "material_id": {
        "type": "string"
      },
      "role": {
        "type": "string",
        "enum": [
          "input",
          "response",
          "handoff",
          "experience"
        ]
      },
      "receiving_task_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Link an immutable Material to a Task with an input, response, handoff, or experience role.",
    "ref": "service://task/task_link_material",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Link an immutable Material to a Task with an input, response, handoff, or experience role.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_link_material",
  "errors": []
}
```

#### task.task_finish

Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.

```json
{
  "name": "task_finish",
  "operation": "task_finish",
  "description": "Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.",
  "input_schema": {
    "type": "object",
    "required": [
      "outcome"
    ],
    "properties": {
      "outcome": {
        "type": "string",
        "enum": [
          "done",
          "incomplete",
          "blocked",
          "cancelled"
        ]
      },
      "material_ids": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "check_result_id": {
        "type": "string"
      },
      "handoff_material_id": {
        "type": "string"
      },
      "blocker": {
        "type": "object"
      },
      "dependency": {
        "type": "object"
      },
      "wait_for": {
        "type": [
          "string",
          "object"
        ]
      },
      "replacement_task_id": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.",
    "ref": "service://task/task_finish",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Persist a finish intent (done, incomplete, blocked, or cancelled). Cleanup closes the Execution before the Task is released; inspect Task detail for closure.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_finish",
  "errors": []
}
```

#### task.workspace_public_files

List files in the immutable Mission Workspace revision before a Task is taken.

```json
{
  "name": "workspace_public_files",
  "operation": "workspace_public_files",
  "description": "List files in the immutable Mission Workspace revision before a Task is taken.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "revision": {
        "type": "string"
      },
      "path": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "mission-read",
  "help": {
    "when": "List files in the immutable Mission Workspace revision before a Task is taken.",
    "ref": "service://task/workspace_public_files",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: List files in the immutable Mission Workspace revision before a Task is taken.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_files",
  "errors": []
}
```

#### task.workspace_public_read

Read one file from an immutable Mission Workspace revision before a Task is taken.

```json
{
  "name": "workspace_public_read",
  "operation": "workspace_public_read",
  "description": "Read one file from an immutable Mission Workspace revision before a Task is taken.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "path"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "revision": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "max_bytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000000
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "mission-read",
  "help": {
    "when": "Read one file from an immutable Mission Workspace revision before a Task is taken.",
    "ref": "service://task/workspace_public_read",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read one file from an immutable Mission Workspace revision before a Task is taken.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_read",
  "errors": []
}
```

#### task.workspace_public_search

Search text in an immutable Mission Workspace revision before a Task is taken.

```json
{
  "name": "workspace_public_search",
  "operation": "workspace_public_search",
  "description": "Search text in an immutable Mission Workspace revision before a Task is taken.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "query"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "revision": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "query": {
        "type": "string"
      },
      "max_results": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "mission-read",
  "help": {
    "when": "Search text in an immutable Mission Workspace revision before a Task is taken.",
    "ref": "service://task/workspace_public_search",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Search text in an immutable Mission Workspace revision before a Task is taken.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_search",
  "errors": []
}
```

#### task.workspace_public_apply

Materialize a selected public Mission Workspace revision into the current Execution directory.

```json
{
  "name": "workspace_public_apply",
  "operation": "workspace_public_apply",
  "description": "Materialize a selected public Mission Workspace revision into the current Execution directory.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "target_dir"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "revision": {
        "type": "string"
      },
      "target_dir": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Materialize a selected public Mission Workspace revision into the current Execution directory.",
    "ref": "service://task/workspace_public_apply",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Materialize a selected public Mission Workspace revision into the current Execution directory.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_apply",
  "errors": []
}
```

#### task.workspace_save

Save a complete public Mission Workspace file tree as an immutable revision without advancing main.

```json
{
  "name": "workspace_save",
  "operation": "workspace_save",
  "description": "Save a complete public Mission Workspace file tree as an immutable revision without advancing main.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "base_revision",
      "files"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "base_revision": {
        "type": "string"
      },
      "files": {
        "type": "object"
      },
      "source": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Save a complete public Mission Workspace file tree as an immutable revision without advancing main.",
    "ref": "service://task/workspace_save",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Save a complete public Mission Workspace file tree as an immutable revision without advancing main.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_save",
  "errors": []
}
```

#### task.workspace_merge

Conditionally merge one complete public Workspace revision into main after conflict and check validation.

```json
{
  "name": "workspace_merge",
  "operation": "workspace_merge",
  "description": "Conditionally merge one complete public Workspace revision into main after conflict and check validation.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "from_revision",
      "expected_main_revision"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "from_revision": {
        "type": "string"
      },
      "expected_main_revision": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Conditionally merge one complete public Workspace revision into main after conflict and check validation.",
    "ref": "service://task/workspace_merge",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Conditionally merge one complete public Workspace revision into main after conflict and check validation.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_merge",
  "errors": []
}
```

#### task.mission_submit

Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.

```json
{
  "name": "mission_submit",
  "operation": "mission_submit",
  "description": "Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id",
      "workspace_id",
      "main_revision",
      "actor_ref"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "workspace_id": {
        "type": "string"
      },
      "main_revision": {
        "type": "string"
      },
      "material_ids": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "checker": {
        "type": [
          "string",
          "null"
        ]
      },
      "environment": {
        "type": [
          "string",
          "null"
        ]
      },
      "acceptance": {
        "type": "object"
      },
      "actor_ref": {
        "type": "string"
      },
      "request_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [],
  "requires_binding": false,
  "scope": "mission-write",
  "help": {
    "when": "Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.",
    "ref": "service://task/mission_submit",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Freeze the selected Workspace main revision and immutable Material/checker inputs for Mission acceptance.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/mission_submit",
  "errors": []
}
```

#### task.mission_submission_get

Read the durable Mission submission state and its immutable acceptance snapshot.

```json
{
  "name": "mission_submission_get",
  "operation": "mission_submission_get",
  "description": "Read the durable Mission submission state and its immutable acceptance snapshot.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "submission_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [],
  "requires_binding": false,
  "scope": "mission-read",
  "help": {
    "when": "Read the durable Mission submission state and its immutable acceptance snapshot.",
    "ref": "service://task/mission_submission_get",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read the durable Mission submission state and its immutable acceptance snapshot.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/mission_submission_get",
  "errors": []
}
```

### Context Service: 6 registered capabilities

Exact normalized built-in manifest metadata:

```json
{
  "manifest_version": "1",
  "service_id": "context",
  "id": "context",
  "title": "Context Service",
  "purpose": "Versioned shared Materials and provenance.",
  "provider_version": "builtin-1",
  "contract_version": "1",
  "endpoint": {
    "transport": "in-process"
  },
  "metadata": {},
  "health": {
    "path": "/healthz"
  },
  "readiness": {
    "path": "/readyz"
  },
  "manifest_hash": "f773f88432bfed97efcae390c55a002e54a33596857cf525047d76dd47d349e5"
}
```

#### context.context_read

Read immutable shared Materials published by other Executions.

```json
{
  "name": "context_read",
  "operation": "read_materials",
  "description": "Read immutable shared Materials published by other Executions.",
  "input_schema": {
    "type": "object",
    "additionalProperties": true,
    "properties": {}
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "public-read",
  "help": {
    "when": "Read immutable shared Materials published by other Executions.",
    "ref": "service://context/read_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Read immutable shared Materials published by other Executions.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/read_materials",
  "errors": []
}
```

#### context.context_consume

Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.

```json
{
  "name": "context_consume",
  "operation": "consume_materials",
  "description": "Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.",
  "input_schema": {
    "type": "object",
    "required": [
      "material_ids",
      "action"
    ],
    "properties": {
      "material_ids": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "action": {
        "type": "string",
        "enum": [
          "route",
          "task",
          "workspace",
          "integration"
        ]
      },
      "action_ref": {
        "type": [
          "string",
          "null"
        ]
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.",
    "ref": "service://context/consume_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/consume_materials",
  "errors": []
}
```

#### context.context_publish

Publish a versioned shared Material for other Executions.

```json
{
  "name": "context_publish",
  "operation": "publish_material",
  "description": "Publish a versioned shared Material for other Executions.",
  "input_schema": {
    "type": "object",
    "required": [
      "kind",
      "scope",
      "content"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "assumption",
          "fact",
          "conjecture",
          "experience",
          "failure",
          "artifact",
          "steer",
          "check_result"
        ]
      },
      "scope": {
        "type": "string"
      },
      "content": {},
      "evidence_state": {
        "type": "string",
        "enum": [
          "proposed",
          "observed",
          "checked",
          "accepted",
          "rejected",
          "stale"
        ]
      }
    },
    "additionalProperties": true
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Publish a versioned shared Material for other Executions.",
    "ref": "service://context/publish_material",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Publish a versioned shared Material for other Executions.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/publish_material",
  "errors": []
}
```

#### context.context_search_materials

Search shared immutable Materials by summary, role, Task, producer, or Mission.

```json
{
  "name": "context_search_materials",
  "operation": "context_search_materials",
  "description": "Search shared immutable Materials by summary, role, Task, producer, or Mission.",
  "input_schema": {
    "type": "object",
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "query": {
        "type": "string"
      },
      "role": {
        "type": "string"
      },
      "task_id": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "context-read",
  "help": {
    "when": "Search shared immutable Materials by summary, role, Task, producer, or Mission.",
    "ref": "service://context/context_search_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Search shared immutable Materials by summary, role, Task, producer, or Mission.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/context_search_materials",
  "errors": []
}
```

#### context.context_get_material

Read one immutable Material and its producer Task/Execution provenance.

```json
{
  "name": "context_get_material",
  "operation": "context_get_material",
  "description": "Read one immutable Material and its producer Task/Execution provenance.",
  "input_schema": {
    "type": "object",
    "required": [
      "material_id"
    ],
    "properties": {
      "material_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "context-read",
  "help": {
    "when": "Read one immutable Material and its producer Task/Execution provenance.",
    "ref": "service://context/context_get_material",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Read one immutable Material and its producer Task/Execution provenance.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/context_get_material",
  "errors": []
}
```

#### context.context_publish_material

Publish durable Response, Handoff, or Experience Material with current Task/Execution provenance.

```json
{
  "name": "context_publish_material",
  "operation": "context_publish_material",
  "description": "Publish durable Response, Handoff, or Experience Material with current Task/Execution provenance.",
  "input_schema": {
    "type": "object",
    "required": [
      "role",
      "content"
    ],
    "properties": {
      "role": {
        "type": "string",
        "enum": [
          "response",
          "handoff",
          "experience"
        ]
      },
      "kind": {
        "type": "string",
        "description": "Material kind, for example fact, experience, failure, or artifact."
      },
      "scope": {
        "type": "string",
        "description": "The bounded collaboration or proof scope for the Material."
      },
      "evidence_state": {
        "type": "string",
        "enum": [
          "proposed",
          "observed",
          "checked",
          "accepted",
          "rejected",
          "stale"
        ]
      },
      "content": {},
      "summary": {
        "type": "string"
      },
      "receiving_task_id": {
        "type": "string"
      },
      "supersedes": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "context-write",
  "help": {
    "when": "Publish durable Response, Handoff, or Experience Material with current Task/Execution provenance.",
    "ref": "service://context/context_publish_material",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Publish durable Response, Handoff, or Experience Material with current Task/Execution provenance.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/context_publish_material",
  "errors": []
}
```

### Judge Service: 2 registered capabilities

Exact normalized built-in manifest metadata:

```json
{
  "manifest_version": "1",
  "service_id": "judge",
  "id": "judge",
  "title": "Judge Service",
  "purpose": "Workspace source checking and structured CheckResults.",
  "provider_version": "builtin-1",
  "contract_version": "1",
  "endpoint": {
    "transport": "in-process"
  },
  "metadata": {},
  "health": {
    "path": "/healthz"
  },
  "readiness": {
    "path": "/readyz"
  },
  "manifest_hash": "25c33bdbbbe2f8d40cdbcd6a69ce01eae6be2fe99a69042f34008dd90fafb9fe"
}
```

#### judge.judge_workspace_check

Check a Workspace file reference against the configured checker and return a durable CheckResult.

```json
{
  "name": "judge_workspace_check",
  "operation": "workspace_check",
  "description": "Check a Workspace file reference against the configured checker and return a durable CheckResult.",
  "input_schema": {
    "type": "object",
    "required": [
      "path"
    ],
    "properties": {
      "workspace_id": {
        "type": "string",
        "minLength": 1
      },
      "revision": {
        "type": "string",
        "pattern": "^\\d+\\.\\d+$"
      },
      "path": {
        "type": "string",
        "minLength": 1
      },
      "workspace_revision": {
        "type": "integer",
        "minimum": 1
      },
      "content_hash": {
        "type": "string",
        "minLength": 1
      },
      "request_key": {
        "type": "string",
        "minLength": 1
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-write",
  "help": {
    "when": "Check a Workspace file reference against the configured checker and return a durable CheckResult.",
    "ref": "service://judge/workspace_check",
    "text": "Purpose: Workspace source checking and structured CheckResults.\nUse when: Check a Workspace file reference against the configured checker and return a durable CheckResult.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_check",
  "errors": []
}
```

#### judge.judge_get_check_result

Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.

```json
{
  "name": "judge_get_check_result",
  "operation": "get_check_result",
  "description": "Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.",
  "input_schema": {
    "type": "object",
    "properties": {
      "check_result_id": {
        "type": "string"
      },
      "request_key": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": [
      "object",
      "array",
      "string",
      "number",
      "boolean",
      "null"
    ]
  },
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-read",
  "help": {
    "when": "Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.",
    "ref": "service://judge/get_check_result",
    "text": "Purpose: Workspace source checking and structured CheckResults.\nUse when: Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/get_check_result",
  "errors": []
}
```

### Runtime-owned capabilities

These declarations are merged into a Session profile after deployment filtering. They are not registered HTTP providers. Most Runtime output schemas are empty strict-object placeholders; they do not enumerate the actual return fields described in the narrative chapters.

#### runtime.execution_get

```json
{
  "id": "runtime.execution_get",
  "name": "execution_get",
  "operation": "get_execution",
  "service_id": "runtime",
  "service_title": "SwarmEnv Runtime",
  "service_purpose": "Task-scoped Execution projection",
  "description": "Read the current Execution identity and Workspace revision.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Read the current Execution before acting on its Task.",
    "ref": "runtime://execution_get"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "execution_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "execution_id"
    ],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.workspace_get

```json
{
  "id": "runtime.workspace_get",
  "name": "workspace_get",
  "operation": "get_workspace",
  "service_id": "runtime",
  "service_title": "Task Workspace",
  "service_purpose": "Task-scoped Workspace materialization and revision contract",
  "description": "Read the current task-scoped Workspace and its revision contract.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Read the Workspace contract before opening or changing files.",
    "ref": "workspace://get"
  },
  "input_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.workspace_list_files

```json
{
  "id": "runtime.workspace_list_files",
  "name": "workspace_list_files",
  "operation": "list_workspace_files",
  "service_id": "runtime",
  "service_title": "Task Workspace",
  "service_purpose": "Task-scoped Workspace materialization and revision contract",
  "description": "List files inside the current task-scoped Workspace.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "List files before reading or writing a declared path.",
    "ref": "workspace://list-files"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.workspace_read_file

```json
{
  "id": "runtime.workspace_read_file",
  "name": "workspace_read_file",
  "operation": "read_workspace_file",
  "service_id": "runtime",
  "service_title": "Task Workspace",
  "service_purpose": "Task-scoped Workspace materialization and revision contract",
  "description": "Read a text file from the current task-scoped Workspace.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Read only a path allowed by the Workspace contract.",
    "ref": "workspace://read-file"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "minLength": 1
      },
      "max_bytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000000
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.workspace_write_file

```json
{
  "id": "runtime.workspace_write_file",
  "name": "workspace_write_file",
  "operation": "write_workspace_file",
  "service_id": "runtime",
  "service_title": "Task Workspace",
  "service_purpose": "Task-scoped Workspace materialization and revision contract",
  "description": "Write one declared output file in the current task-scoped Workspace and save a revision.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Write only declared outputs with the current Workspace revision.",
    "ref": "workspace://write-file"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "minLength": 1
      },
      "content": {
        "type": "string"
      },
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "required": [
      "path",
      "content"
    ],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.sandbox_exec

```json
{
  "id": "runtime.sandbox_exec",
  "name": "sandbox_exec",
  "operation": "sandbox_exec",
  "service_id": "runtime",
  "service_title": "Task Sandbox",
  "service_purpose": "Bounded command execution inside the Execution Sandbox",
  "description": "Run a bounded shell command inside the current Execution Sandbox at /workspace. With an external provider, /workspace is provider-owned and must not be assumed to be the host Runtime Workspace until the provider worker integration is enabled; shell edits become durable only after the configured continuity path saves them.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "write",
  "idempotent": false,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Use for compilation, tests, rg, or other code execution inside the bound Workspace.",
    "ref": "sandbox://exec"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "oneOf": [
          {
            "type": "string",
            "minLength": 1
          },
          {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string"
            }
          }
        ]
      },
      "cwd": {
        "type": "string",
        "description": "Container path under /workspace."
      },
      "timeout_ms": {
        "type": "integer",
        "minimum": 1,
        "maximum": 3600000
      },
      "env": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "background": {
        "type": "boolean"
      }
    },
    "required": [
      "command"
    ],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "execution_id": {
        "type": "string"
      },
      "job_id": {
        "type": "string"
      },
      "binding_version": {
        "type": "integer"
      },
      "exit_code": {
        "type": [
          "integer",
          "null"
        ]
      },
      "timed_out": {
        "type": "boolean"
      },
      "truncated": {
        "type": "boolean"
      },
      "stdout": {
        "type": "string"
      },
      "stderr": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### runtime.sandbox_job

```json
{
  "id": "runtime.sandbox_job",
  "name": "sandbox_job",
  "operation": "sandbox_job",
  "service_id": "runtime",
  "service_title": "Task Sandbox",
  "service_purpose": "Bounded command execution inside the Execution Sandbox",
  "description": "Read or cancel a background Sandbox job created by this Execution.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Inspect or stop a background command before handing off the Execution.",
    "ref": "sandbox://job"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "job_id": {
        "type": "string",
        "minLength": 1
      },
      "action": {
        "type": "string",
        "enum": [
          "status",
          "cancel"
        ]
      }
    },
    "required": [
      "job_id"
    ],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

#### runtime.workspace_diff

```json
{
  "id": "runtime.workspace_diff",
  "name": "workspace_diff",
  "operation": "workspace_diff",
  "service_id": "runtime",
  "service_title": "Task Workspace",
  "service_purpose": "Task-scoped Workspace materialization and revision contract",
  "description": "Compare two revisions in the current task-scoped Workspace.",
  "audience": [
    "bound",
    "recovery"
  ],
  "side_effect": "read",
  "idempotent": true,
  "runtime_owned": true,
  "context": [
    "task",
    "execution",
    "fencing"
  ],
  "help": {
    "when": "Inspect the auditable file changes between revisions.",
    "ref": "workspace://diff"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "from_revision": {
        "type": "integer",
        "minimum": 1
      },
      "to_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

### Optional Mathlib Search manifest

Exact repository bundle declaration. Loading the bundle additionally binds its documentation hashes into the normalized manifest; deployment endpoint overrides change the manifest hash. The implementation also returns `duration_ms` and, after fallback, `fallback`/`upstream_error_code`; these are not listed in this declaration's closed output schema.

```json
{
  "id": "mathlib-search",
  "title": "Mathlib Search",
  "purpose": "Search Lean and Mathlib declarations before selecting a proof or API route.",
  "provider_version": "1.0.0",
  "contract_version": "1",
  "endpoint": { "transport": "in-process" },
  "documentation": {
    "skill": "SKILL.md",
    "references": ["references/loogle.md"]
  },
  "secret_refs": {
    "token": "env:SWARMENV_MATHLIB_SEARCH_TOKEN"
  },
  "metadata": {
    "backend": "loogle-compatible"
  },
  "capabilities": [
    {
      "name": "mathlib_search",
      "operation": "mathlib_search",
      "description": "Search Mathlib declarations by Lean type, name, or query text.",
      "audience": ["bound", "recovery"],
      "side_effect": "read",
      "idempotent": true,
      "context": ["task", "execution"],
      "requires_binding": true,
      "help": {
        "when": "Use before proposing a proof or API research Task; search by a declaration name or Lean type pattern and verify the result in the locked project.",
        "ref": "service://mathlib-search/skill"
      },
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "minLength": 1, "maxLength": 2000 },
          "module": { "type": "string", "minLength": 1, "maxLength": 200 },
          "path": { "type": "string", "minLength": 1, "maxLength": 1000 },
          "max_results": { "type": "integer", "minimum": 1, "maximum": 50 }
        },
        "required": ["query"],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "results": { "type": "array" },
          "result_count": { "type": "integer", "minimum": 0 },
          "truncated": { "type": "boolean" },
          "backend": { "type": "string" },
          "mathlib_revision": { "type": ["string", "null"] },
          "lean_version": { "type": ["string", "null"] }
        },
        "additionalProperties": false
      },
      "path": "/v1/mathlib_search",
      "errors": [
        { "code": "INVALID_CONTRACT", "retryable": false },
        { "code": "SERVICE_TIMEOUT", "retryable": true },
        { "code": "SERVICE_UNAVAILABLE", "retryable": true }
      ]
    }
  ]
}
```

### Additional catalog entries retained for compatibility/internal callers

This section records every extra catalog declaration not represented by the registered built-in operation set above. It is not an authorization list for the current Agent. Internal SDK/domain methods can have additional operations that are never a model tool; see the operation routing section in [Services](04-services.md).

#### Catalog task.workspace_get / get_workspace

```json
{
  "name": "workspace_get",
  "service": "task",
  "operation": "get_workspace",
  "version": "1.0",
  "description": "Read the current Workspace materialization and revision.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog task.workspace_revisions / list_workspace_revisions

```json
{
  "name": "workspace_revisions",
  "service": "task",
  "operation": "list_workspace_revisions",
  "version": "1.0",
  "description": "List Workspace revisions available to the current Execution.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog task.workspace_list_files / list_workspace_files

```json
{
  "name": "workspace_list_files",
  "service": "task",
  "operation": "list_workspace_files",
  "version": "1.0",
  "description": "List project files in the current Workspace. Runtime metadata is excluded.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    },
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog task.workspace_read_file / read_workspace_file

```json
{
  "name": "workspace_read_file",
  "service": "task",
  "operation": "read_workspace_file",
  "version": "1.0",
  "description": "Read a text file from the current Workspace.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "required": [
      "path"
    ],
    "properties": {
      "path": {
        "type": "string"
      },
      "max_bytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000000
      }
    },
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog task.workspace_write_file / write_workspace_file

```json
{
  "name": "workspace_write_file",
  "service": "task",
  "operation": "write_workspace_file",
  "version": "1.0",
  "description": "Create or replace one project file in the current Workspace and save an auditable revision.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "path",
      "content"
    ],
    "properties": {
      "path": {
        "type": "string"
      },
      "content": {
        "type": "string"
      },
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog task.workspace_diff / workspace_diff

```json
{
  "name": "workspace_diff",
  "service": "task",
  "operation": "workspace_diff",
  "version": "1.0",
  "description": "Show file hash changes between two Workspace revisions.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "from_revision": {
        "type": "integer",
        "minimum": 1
      },
      "to_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  },
  "capability": "workspace"
}
```

#### Catalog execution.execution_get / get_execution

```json
{
  "name": "execution_get",
  "service": "execution",
  "operation": "get_execution",
  "version": "1.0",
  "description": "Read the current Execution lease, Workspace revision and checkpoint.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "execution_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_get / get_workspace

```json
{
  "name": "workspace_get",
  "service": "workspace",
  "operation": "get_workspace",
  "version": "1.0",
  "description": "Read the current Workspace materialization and revision.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_revisions / list_workspace_revisions

```json
{
  "name": "workspace_revisions",
  "service": "workspace",
  "operation": "list_workspace_revisions",
  "version": "1.0",
  "description": "List Workspace revisions available to the current Execution.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_list_files / list_workspace_files

```json
{
  "name": "workspace_list_files",
  "service": "workspace",
  "operation": "list_workspace_files",
  "version": "1.0",
  "description": "List project files in the current Workspace. Runtime metadata is excluded.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_read_file / read_workspace_file

```json
{
  "name": "workspace_read_file",
  "service": "workspace",
  "operation": "read_workspace_file",
  "version": "1.0",
  "description": "Read a text file from the current Workspace.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "required": [
      "path"
    ],
    "properties": {
      "path": {
        "type": "string"
      },
      "max_bytes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000000
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_write_file / write_workspace_file

```json
{
  "name": "workspace_write_file",
  "service": "workspace",
  "operation": "write_workspace_file",
  "version": "1.0",
  "description": "Create or replace one project file in the current Workspace and save an auditable revision.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "path",
      "content"
    ],
    "properties": {
      "path": {
        "type": "string"
      },
      "content": {
        "type": "string"
      },
      "expected_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog workspace.workspace_diff / workspace_diff

```json
{
  "name": "workspace_diff",
  "service": "workspace",
  "operation": "workspace_diff",
  "version": "1.0",
  "description": "Show file hash changes between two Workspace revisions.",
  "scope": "execution-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "from_revision": {
        "type": "integer",
        "minimum": 1
      },
      "to_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": false
  }
}
```

### Complete local SDK dispatch mapping

The SDK constructor requires `dispatch` and `actorRef`. `withContext` creates another SDK with merged context. The methods below are the complete direct read/write wrappers, extracted from the source. This table records local/internal entry points, not the current Agent tool authorization list. Each call constructs an envelope from its context and explicit write options; read calls also have an operation ID. `createMission` and `proposeTask` clear Task/Execution/fence binding; `taskTake` supplies the context actor and configured Core lane. Structural methods select the Task state version from explicit options/context.

| SDK method | Dispatched operation | Wrapper |
|---|---|---|
| `getExecution` | `get_execution` | read |
| `listTasks` | `list_tasks` | read |
| `createMission` | `create_mission` | write |
| `getMission` | `get_mission` | read |
| `createTask` | `create_task` | write |
| `listMissionTasks` | `list_task` | read |
| `taskStatus` | `task_status` | read |
| `viewTask` | `view_task` | read |
| `linkMaterial` | `task_link_material` | write |
| `listTaskMaterials` | `list_task_materials` | read |
| `finishTask` | `task_finish` | write |
| `listExecutions` | `list_executions` | read |
| `listServices` | `list_services` | read |
| `getServiceMetadata` | `get_service_metadata` | read |
| `listTools` | `list_tools` | read |
| `readMaterials` | `read_materials` | read |
| `searchMaterials` | `context_search_materials` | read |
| `getMaterial` | `context_get_material` | read |
| `publishCollaborationMaterial` | `context_publish_material` | write |
| `consumeMaterials` | `consume_materials` | write |
| `listMaterialConsumptions` | `list_material_consumptions` | read |
| `getCheckResult` | `get_check_result` | read |
| `taskTake` | `task_take` | write |
| `taskFeedback` | `task_feedback` | write |
| `executionProgress` | `execution_progress` | write |
| `heartbeat` | `heartbeat` | write |
| `publishMaterial` | `publish_material` | write |

### Complete local router fallback sets

Registry matches are resolved first by capability name or operation and must be unique. Only when no Registry match exists does the local router use these exact fallback sets. Candidate submission belongs to Task here; only result retrieval belongs directly to Judge. Unlisted operations fail with no service route.

#### TASK fallback operations

```json
[
  "get_execution",
  "list_tasks",
  "list_executions",
  "create_mission",
  "get_mission",
  "create_task",
  "list_task",
  "view_task",
  "task_list",
  "task_view",
  "task_create",
  "task_status",
  "task_take",
  "task_feedback",
  "execution_progress",
  "link_material",
  "task_link_material",
  "list_task_materials",
  "task_materials",
  "finish_task",
  "task_finish"
]
```

#### CONTEXT fallback operations

```json
[
  "publish_material",
  "context.publish_material",
  "context_publish_material",
  "read_materials",
  "context.read_materials",
  "context_read_materials",
  "search_materials",
  "context.search_materials",
  "context_search_materials",
  "get_material",
  "context.get_material",
  "context_get_material",
  "consume_materials",
  "list_material_consumptions",
  "material.publish",
  "material_publish",
  "material.read",
  "material_read",
  "material.search",
  "material_search",
  "material.get",
  "material_get",
  "material_dispute",
  "material.dispute",
  "material_supersede",
  "material.supersede",
  "material_unsupersede",
  "material.unsupersede"
]
```

#### JUDGE fallback operations

```json
[
  "workspace_check",
  "get_check_result"
]
```

### Exact shared error-code vocabulary

```json
{
  "CONFLICT": "CONFLICT",
  "FENCED": "FENCED",
  "INVALID_CONTRACT": "INVALID_CONTRACT",
  "NOT_ALLOWED": "NOT_ALLOWED",
  "PROCESS_EXITED": "PROCESS_EXITED",
  "RPC_ERROR": "RPC_ERROR",
  "START_FAILED": "START_FAILED",
  "CHECKER_UNAVAILABLE": "CHECKER_UNAVAILABLE",
  "BRANCH_TASK_CANNOT_CREATE_BRANCH": "BRANCH_TASK_CANNOT_CREATE_BRANCH",
  "STALE_VERSION": "STALE_VERSION",
  "BACKPRESSURE_ROOT_UNFINISHED_LIMIT": "BACKPRESSURE_ROOT_UNFINISHED_LIMIT",
  "BACKPRESSURE_ROOT_OPEN_LIMIT": "BACKPRESSURE_ROOT_OPEN_LIMIT",
  "BACKPRESSURE_EXECUTION_CHILD_LIMIT": "BACKPRESSURE_EXECUTION_CHILD_LIMIT",
  "BACKPRESSURE_TURN_MUTATION_LIMIT": "BACKPRESSURE_TURN_MUTATION_LIMIT",
  "FAIRNESS_REQUIRED": "FAIRNESS_REQUIRED",
  "DUPLICATE_RESPONSIBILITY": "DUPLICATE_RESPONSIBILITY",
  "INVALID_TASK_CONTRACT": "INVALID_TASK_CONTRACT",
  "SELECTION_INVALID": "SELECTION_INVALID",
  "CLAIM_INVALID": "CLAIM_INVALID",
  "RUNTIME_HANDOFF_REQUIRED": "RUNTIME_HANDOFF_REQUIRED",
  "SERVICE_MANIFEST_INVALID": "SERVICE_MANIFEST_INVALID",
  "SERVICE_ALREADY_REGISTERED": "SERVICE_ALREADY_REGISTERED",
  "SERVICE_NOT_FOUND": "SERVICE_NOT_FOUND",
  "SERVICE_CAPABILITY_NOT_FOUND": "SERVICE_CAPABILITY_NOT_FOUND",
  "SERVICE_CAPABILITY_NOT_ALLOWED": "SERVICE_CAPABILITY_NOT_ALLOWED",
  "SERVICE_UNAVAILABLE": "SERVICE_UNAVAILABLE",
  "SERVICE_NOT_READY": "SERVICE_NOT_READY",
  "SERVICE_VERSION_MISMATCH": "SERVICE_VERSION_MISMATCH",
  "SERVICE_TIMEOUT": "SERVICE_TIMEOUT"
}
```

<!-- END GENERATED REFERENCE -->
