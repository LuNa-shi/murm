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
| [src/sdk/service-catalog.js](../../src/sdk/service-catalog.js) | `951de6a9e5ef0bdfee80f36263b508783256c55f5834b28ed1485e3385983e7b` |
| [src/sdk/builtin-registry.js](../../src/sdk/builtin-registry.js) | `528c5679002a17c048332291f2c5a51a4c7c9160467379dc1198cc604e667a6d` |
| [src/sdk/service-manifest.js](../../src/sdk/service-manifest.js) | `415bf40c46e284fbd5ad52fc5f7c96266003edb5573dba3a55c734966b9e01bf` |
| [src/sdk/service-registry.js](../../src/sdk/service-registry.js) | `6528826cb1e89980159bc23150e6f18162df54ac3f9eb5eda264befb6160dc46` |
| [src/agent/capability-profile.js](../../src/agent/capability-profile.js) | `5be1832ad5b7e08437ded98d21f98445874a683c7127b97305b8ca370e3421b6` |
| [src/agent/services-bridge.js](../../src/agent/services-bridge.js) | `b80c43ffd54f7f0b2c829df37e1bf1c1ad71d833f5fd98844c414f8e343c2ef7` |
| [src/sdk/services-sdk.js](../../src/sdk/services-sdk.js) | `778e951a2f200b788658de6f7cb8e5e06696035745fa35406d9960457c8c5089` |
| [src/sdk/service-router.js](../../src/sdk/service-router.js) | `c26e5b1047fb77a779564462962131fbe7af4437edacbedf1e1096f19183bf22` |
| [src/runtime/runtime-capabilities.js](../../src/runtime/runtime-capabilities.js) | `e53aef2c60ef61eccbefdb05135958803f1c100b7505de5abe75103f7e2e8d05` |
| [src/benchmark/putnam-runner.js](../../src/benchmark/putnam-runner.js) | `a0d1c160752758ab79d6e223c999a4bcc37a159f784e3a048f70cd54b3a724bf` |
| [services/mathlib-search/service.json](../../services/mathlib-search/service.json) | `616a349bea3dc7282f26a90a3c8882d06afe846c58fdbf00a851404546c15b70` |
| [src/errors.js](../../src/errors.js) | `f4bf3103fbbb445233a4fbd07510265a9b88a5857071b134c735d2f63af6323b` |

### Exact tool exposure for the built-in benchmark

The two profile columns describe the compatibility extension surface after Sandbox filtering. Registered Bots receive the four native Pi tools (`read`, `write`, `edit`, `bash`), and call typed `swarm` commands through Bash; the `swarmenv_` names below are not a second set of tools loaded into those Bots. Optional registered Services add capabilities. Both built-in `bound` and `recovery` roles currently have the same named surface. Presence in this table does not bypass the Bridge's Task/Execution binding, modern-retired-operation or Workspace-contract checks. `swarmenv_` is the Pi extension prefix.

| Capability identity | flat; Sandbox off | flat; Sandbox on |
|---|---|---|
| `catalog.catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` |
| `catalog.catalog_list_services` | `swarmenv_catalog_list_services` | `swarmenv_catalog_list_services` |
| `catalog.catalog_list_tools` | `swarmenv_catalog_list_tools` | `swarmenv_catalog_list_tools` |
| `context.context_consume` | `swarmenv_context_consume` | `swarmenv_context_consume` |
| `context.context_get_material` | `swarmenv_context_get_material` | `swarmenv_context_get_material` |
| `context.context_publish_material` | `swarmenv_context_publish_material` | `swarmenv_context_publish_material` |
| `context.context_read` | `swarmenv_context_read` | `swarmenv_context_read` |
| `context.context_search_materials` | `swarmenv_context_search_materials` | `swarmenv_context_search_materials` |
| `context.material_dispute` | `swarmenv_material_dispute` | `swarmenv_material_dispute` |
| `context.material_supersede` | `swarmenv_material_supersede` | `swarmenv_material_supersede` |
| `context.material_unsupersede` | `swarmenv_material_unsupersede` | `swarmenv_material_unsupersede` |
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
| `task.bot_exit` | `swarmenv_bot_exit` | `swarmenv_bot_exit` |
| `task.execution_progress` | `swarmenv_execution_progress` | `swarmenv_execution_progress` |
| `task.mission_get` | `swarmenv_mission_get` | `swarmenv_mission_get` |
| `task.mission_submission_get` | `swarmenv_mission_submission_get` | `swarmenv_mission_submission_get` |
| `task.mission_submit` | `swarmenv_mission_submit` | `swarmenv_mission_submit` |
| `task.task_cancel` | `swarmenv_task_cancel` | `swarmenv_task_cancel` |
| `task.task_create` | `swarmenv_task_create` | `swarmenv_task_create` |
| `task.task_dependency_replace` | `swarmenv_task_dependency_replace` | `swarmenv_task_dependency_replace` |
| `task.task_feedback` | `swarmenv_task_feedback` | `swarmenv_task_feedback` |
| `task.task_finish` | `swarmenv_task_finish` | `swarmenv_task_finish` |
| `task.task_link_material` | `swarmenv_task_link_material` | `swarmenv_task_link_material` |
| `task.task_list` | `swarmenv_task_list` | `swarmenv_task_list` |
| `task.task_status` | `swarmenv_task_status` | `swarmenv_task_status` |
| `task.task_take` | `swarmenv_task_take` | `swarmenv_task_take` |
| `task.task_view` | `swarmenv_task_view` | `swarmenv_task_view` |
| `task.workspace_current_diff` | `swarmenv_workspace_current_diff` | `swarmenv_workspace_current_diff` |
| `task.workspace_merge` | `swarmenv_workspace_merge` | `swarmenv_workspace_merge` |
| `task.workspace_public_apply` | `swarmenv_workspace_public_apply` | `swarmenv_workspace_public_apply` |
| `task.workspace_public_diff` | `swarmenv_workspace_public_diff` | `swarmenv_workspace_public_diff` |
| `task.workspace_public_files` | `swarmenv_workspace_public_files` | `swarmenv_workspace_public_files` |
| `task.workspace_public_history` | `swarmenv_workspace_public_history` | `swarmenv_workspace_public_history` |
| `task.workspace_public_read` | `swarmenv_workspace_public_read` | `swarmenv_workspace_public_read` |
| `task.workspace_public_search` | `swarmenv_workspace_public_search` | `swarmenv_workspace_public_search` |
| `task.workspace_public_view` | `swarmenv_workspace_public_view` | `swarmenv_workspace_public_view` |
| `task.workspace_save` | `swarmenv_workspace_save` | `swarmenv_workspace_save` |
| `task.workspace_status` | `swarmenv_workspace_status` | `swarmenv_workspace_status` |

The flat Mission Task profile is the only Agent-facing Task model. Retired structural and lease operations may remain in internal catalog definitions for storage/analysis compatibility, but are filtered from the built-in Registry and cannot be called by a bound Agent. Registered Bots use explicit save/publish and `task_finish`; the old `execution_progress` compound path is rejected.

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

### Task Service: 26 registered capabilities

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
  "manifest_hash": "68fdfc90b1ac987bafde92f69e16a23b15529699a8d05d7ab108cb0c5920b2af"
}
```

#### task.bot_exit

End this unbound Bot after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.

```json
{
  "name": "bot_exit",
  "operation": "bot_exit",
  "description": "End this unbound Bot after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.",
  "input_schema": {
    "type": "object",
    "required": [
      "reason"
    ],
    "properties": {
      "reason": {
        "type": "string",
        "enum": [
          "no-work",
          "selection-budget"
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
  "context": [],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "End this unbound Bot after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.",
    "ref": "service://task/bot_exit",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: End this unbound Bot after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/bot_exit",
  "errors": []
}
```

#### task.task_status

Read Mission counts and bounded Task and eligibility previews; use Task list to continue discovery.

```json
{
  "name": "task_status",
  "operation": "task_status",
  "description": "Read Mission counts and bounded Task and eligibility previews; use Task list to continue discovery.",
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
    "when": "Read Mission counts and bounded Task and eligibility previews; use Task list to continue discovery.",
    "ref": "service://task/task_status",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read Mission counts and bounded Task and eligibility previews; use Task list to continue discovery.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_status",
  "errors": []
}
```

#### task.task_take

Take an existing Task in this Mission using the caller Bot and Core.

```json
{
  "name": "task_take",
  "operation": "task_take",
  "description": "Take an existing Task in this Mission using the caller Bot and Core.",
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
    "when": "Take an existing Task in this Mission using the caller Bot and Core.",
    "ref": "service://task/task_take",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Take an existing Task in this Mission using the caller Bot and Core.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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

Search bounded Task summaries across states; follow next_cursor and read Task detail before proposing new work.

```json
{
  "name": "task_list",
  "operation": "task_list",
  "description": "Search bounded Task summaries across states; follow next_cursor and read Task detail before proposing new work.",
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
      "states": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1,
        "maxItems": 16
      },
      "available_only": {
        "type": "boolean"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
    "when": "Search bounded Task summaries across states; follow next_cursor and read Task detail before proposing new work.",
    "ref": "service://task/task_list",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Search bounded Task summaries across states; follow next_cursor and read Task detail before proposing new work.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_list",
  "errors": []
}
```

#### task.task_view

Read a Task contract, proposal provenance, dependencies, Execution history, and linked Materials.

```json
{
  "name": "task_view",
  "operation": "task_view",
  "description": "Read a Task contract, proposal provenance, dependencies, Execution history, and linked Materials.",
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
    "when": "Read a Task contract, proposal provenance, dependencies, Execution history, and linked Materials.",
    "ref": "service://task/task_view",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read a Task contract, proposal provenance, dependencies, Execution history, and linked Materials.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_view",
  "errors": []
}
```

#### task.task_create

Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations. Supply base_revision to require a fixed public Workspace revision; omitting a revision uses main at take.

```json
{
  "name": "task_create",
  "operation": "task_create",
  "description": "Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations. Supply base_revision to require a fixed public Workspace revision; omitting a revision uses main at take.",
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
        "type": "object",
        "description": "Compatibility input. If both workspace.revision and base_revision are supplied, they must match."
      },
      "base_revision": {
        "type": "string",
        "pattern": "^[0-9]+[.][0-9]+$"
      },
      "input_material_refs": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "maxItems": 100
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
    "when": "Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations. Supply base_revision to require a fixed public Workspace revision; omitting a revision uses main at take.",
    "ref": "service://task/task_create",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations. Supply base_revision to require a fixed public Workspace revision; omitting a revision uses main at take.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
      "workspace_revision": {
        "type": "string"
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

#### task.task_cancel

Cancel an unowned ready or blocked Task using an explicit Mission coordination grant and observed versions. Never cancel another owner.

```json
{
  "name": "task_cancel",
  "operation": "task_cancel",
  "description": "Cancel an unowned ready or blocked Task using an explicit Mission coordination grant and observed versions. Never cancel another owner.",
  "input_schema": {
    "type": "object",
    "required": [
      "task_id",
      "expected_spec_version",
      "expected_state_version",
      "reason"
    ],
    "properties": {
      "task_id": {
        "type": "string"
      },
      "expected_spec_version": {
        "type": "integer",
        "minimum": 1
      },
      "expected_state_version": {
        "type": "integer",
        "minimum": 0
      },
      "reason": {
        "type": "string"
      },
      "replacement_task_id": {
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
  "scope": "mission-write",
  "help": {
    "when": "Cancel an unowned ready or blocked Task using an explicit Mission coordination grant and observed versions. Never cancel another owner.",
    "ref": "service://task/task_cancel",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Cancel an unowned ready or blocked Task using an explicit Mission coordination grant and observed versions. Never cancel another owner.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_cancel",
  "errors": []
}
```

#### task.task_dependency_replace

Replace one cancelled prerequisite of an unowned blocked Task, preserving every other dependency and historical edge.

```json
{
  "name": "task_dependency_replace",
  "operation": "task_dependency_replace",
  "description": "Replace one cancelled prerequisite of an unowned blocked Task, preserving every other dependency and historical edge.",
  "input_schema": {
    "type": "object",
    "required": [
      "task_id",
      "from_task_id",
      "to_task_id",
      "expected_spec_version",
      "expected_state_version",
      "reason"
    ],
    "properties": {
      "task_id": {
        "type": "string"
      },
      "from_task_id": {
        "type": "string"
      },
      "to_task_id": {
        "type": "string"
      },
      "expected_spec_version": {
        "type": "integer",
        "minimum": 1
      },
      "expected_state_version": {
        "type": "integer",
        "minimum": 0
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
  "scope": "mission-write",
  "help": {
    "when": "Replace one cancelled prerequisite of an unowned blocked Task, preserving every other dependency and historical edge.",
    "ref": "service://task/task_dependency_replace",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Replace one cancelled prerequisite of an unowned blocked Task, preserving every other dependency and historical edge.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_dependency_replace",
  "errors": []
}
```

#### task.workspace_public_view

Read the public Mission Workspace and current main.

```json
{
  "name": "workspace_public_view",
  "operation": "workspace_public_view",
  "description": "Read the public Mission Workspace and current main.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id"
    ],
    "properties": {
      "workspace_id": {
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
    "when": "Read the public Mission Workspace and current main.",
    "ref": "service://task/workspace_public_view",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read the public Mission Workspace and current main.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_view",
  "errors": []
}
```

#### task.workspace_public_history

Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.

```json
{
  "name": "workspace_public_history",
  "operation": "workspace_public_history",
  "description": "Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "all": {
        "type": "boolean"
      },
      "source_task": {
        "type": "string"
      },
      "source_execution": {
        "type": "string"
      },
      "material_id": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
    "when": "Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.",
    "ref": "service://task/workspace_public_history",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read main history by default or all saved revisions, with provenance and bounded snapshot pagination.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_history",
  "errors": []
}
```

#### task.workspace_public_diff

Compare any two published Mission Workspace revisions, including unmerged saves. Pages pin both revisions.

```json
{
  "name": "workspace_public_diff",
  "operation": "workspace_public_diff",
  "description": "Compare any two published Mission Workspace revisions, including unmerged saves. Pages pin both revisions.",
  "input_schema": {
    "type": "object",
    "required": [
      "workspace_id",
      "from",
      "to"
    ],
    "properties": {
      "workspace_id": {
        "type": "string"
      },
      "from": {
        "type": "string"
      },
      "to": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
    "when": "Compare any two published Mission Workspace revisions, including unmerged saves. Pages pin both revisions.",
    "ref": "service://task/workspace_public_diff",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Compare any two published Mission Workspace revisions, including unmerged saves. Pages pin both revisions.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_public_diff",
  "errors": []
}
```

#### task.workspace_status

Inspect the current E tree, initial revision and saved lineage.

```json
{
  "name": "workspace_status",
  "operation": "workspace_status",
  "description": "Inspect the current E tree, initial revision and saved lineage.",
  "input_schema": {
    "type": "object",
    "required": [],
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
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-read",
  "help": {
    "when": "Inspect the current E tree, initial revision and saved lineage.",
    "ref": "service://task/workspace_status",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Inspect the current E tree, initial revision and saved lineage.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_status",
  "errors": []
}
```

#### task.workspace_current_diff

Compare the current E tree with its last saved revision.

```json
{
  "name": "workspace_current_diff",
  "operation": "workspace_current_diff",
  "description": "Compare the current E tree with its last saved revision.",
  "input_schema": {
    "type": "object",
    "required": [],
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
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "execution-read",
  "help": {
    "when": "Compare the current E tree with its last saved revision.",
    "ref": "service://task/workspace_current_diff",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Compare the current E tree with its last saved revision.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/workspace_current_diff",
  "errors": []
}
```

#### task.mission_get

Read the current Mission goal and acceptance conditions.

```json
{
  "name": "mission_get",
  "operation": "mission_get",
  "description": "Read the current Mission goal and acceptance conditions.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id"
    ],
    "properties": {
      "mission_id": {
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
    "when": "Read the current Mission goal and acceptance conditions.",
    "ref": "service://task/mission_get",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read the current Mission goal and acceptance conditions.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/mission_get",
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
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
        "type": "string",
        "maxLength": 1024
      },
      "max_results": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      },
      "cursor": {
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

Apply a fixed public revision by three-way merge into the current E, retaining conflicts and parents.

```json
{
  "name": "workspace_public_apply",
  "operation": "workspace_public_apply",
  "description": "Apply a fixed public revision by three-way merge into the current E, retaining conflicts and parents.",
  "input_schema": {
    "type": "object",
    "required": [
      "from"
    ],
    "properties": {
      "from": {
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
    "when": "Apply a fixed public revision by three-way merge into the current E, retaining conflicts and parents.",
    "ref": "service://task/workspace_public_apply",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Apply a fixed public revision by three-way merge into the current E, retaining conflicts and parents.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "properties": {
      "resolved": {
        "type": "boolean"
      },
      "material_ids": {
        "type": "array",
        "maxItems": 20,
        "uniqueItems": true,
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
      "from"
    ],
    "properties": {
      "from": {
        "type": "string",
        "pattern": "^\\d+\\.\\d+$"
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
      "material_ids"
    ],
    "properties": {
      "material_ids": {
        "type": "array",
        "maxItems": 100,
        "uniqueItems": true,
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

### Context Service: 8 registered capabilities

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
  "manifest_hash": "453e81ad42ab6062e37da4bbe99db8d3b4ad29e60053a85b1c60880581e4a8f4"
}
```

#### context.context_read

List one page of shared Material summaries. Use an exact Material ID to read its complete content.

```json
{
  "name": "context_read",
  "operation": "read_materials",
  "description": "List one page of shared Material summaries. Use an exact Material ID to read its complete content.",
  "input_schema": {
    "type": "object",
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "material_id": {
        "type": "string"
      },
      "task_id": {
        "type": "string"
      },
      "source_task": {
        "type": "string"
      },
      "source_execution": {
        "type": "string"
      },
      "include_history": {
        "type": "boolean"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
  "scope": "public-read",
  "help": {
    "when": "List one page of shared Material summaries. Use an exact Material ID to read its complete content.",
    "ref": "service://context/read_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: List one page of shared Material summaries. Use an exact Material ID to read its complete content.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
      "action",
      "impact"
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
      "impact": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
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

#### context.material_dispute

Record a specific claim or section and the reason it needs correction; keep the Material visible.

```json
{
  "name": "material_dispute",
  "operation": "material_dispute",
  "description": "Record a specific claim or section and the reason it needs correction; keep the Material visible.",
  "input_schema": {
    "type": "object",
    "required": [
      "material_id",
      "claim",
      "reason"
    ],
    "properties": {
      "material_id": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "claim": {
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
    "when": "Record a specific claim or section and the reason it needs correction; keep the Material visible.",
    "ref": "service://context/material_dispute",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Record a specific claim or section and the reason it needs correction; keep the Material visible.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/material_dispute",
  "errors": []
}
```

#### context.material_supersede

Replace an entire Material with a complete successor using its observed relation_version.

```json
{
  "name": "material_supersede",
  "operation": "material_supersede",
  "description": "Replace an entire Material with a complete successor using its observed relation_version.",
  "input_schema": {
    "type": "object",
    "required": [
      "material_id",
      "replacement_material_id",
      "expected_version",
      "reason"
    ],
    "properties": {
      "material_id": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "replacement_material_id": {
        "type": "string"
      },
      "expected_version": {
        "type": "integer",
        "minimum": 0
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
    "when": "Replace an entire Material with a complete successor using its observed relation_version.",
    "ref": "service://context/material_supersede",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Replace an entire Material with a complete successor using its observed relation_version.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/material_supersede",
  "errors": []
}
```

#### context.material_unsupersede

Revoke only the matching successor using the observed relation_version and a reason; preserve all history.

```json
{
  "name": "material_unsupersede",
  "operation": "material_unsupersede",
  "description": "Revoke only the matching successor using the observed relation_version and a reason; preserve all history.",
  "input_schema": {
    "type": "object",
    "required": [
      "material_id",
      "replacement_material_id",
      "expected_version",
      "reason"
    ],
    "properties": {
      "material_id": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "replacement_material_id": {
        "type": "string"
      },
      "expected_version": {
        "type": "integer",
        "minimum": 0
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
    "when": "Revoke only the matching successor using the observed relation_version and a reason; preserve all history.",
    "ref": "service://context/material_unsupersede",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Revoke only the matching successor using the observed relation_version and a reason; preserve all history.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/material_unsupersede",
  "errors": []
}
```

#### context.context_search_materials

Search immutable Material summaries by keyword, Task, producer, or Mission. Follow continuation cursors and read exact IDs for full content.

```json
{
  "name": "context_search_materials",
  "operation": "context_search_materials",
  "description": "Search immutable Material summaries by keyword, Task, producer, or Mission. Follow continuation cursors and read exact IDs for full content.",
  "input_schema": {
    "type": "object",
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "query": {
        "type": "string"
      },
      "task_id": {
        "type": "string"
      },
      "source_task": {
        "type": "string"
      },
      "source_execution": {
        "type": "string"
      },
      "include_history": {
        "type": "boolean"
      },
      "relation_kind": {
        "type": "string",
        "enum": [
          "supersede",
          "dispute"
        ]
      },
      "related_material_id": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
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
    "when": "Search immutable Material summaries by keyword, Task, producer, or Mission. Follow continuation cursors and read exact IDs for full content.",
    "ref": "service://context/context_search_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Search immutable Material summaries by keyword, Task, producer, or Mission. Follow continuation cursors and read exact IDs for full content.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
      },
      "attachment_name": {
        "type": "string"
      },
      "usage_limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "usage_cursor": {
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

Publish immutable research content and optional attachments with current Task/Execution provenance. Explain evidence in the body where applicable.

```json
{
  "name": "context_publish_material",
  "operation": "context_publish_material",
  "description": "Publish immutable research content and optional attachments with current Task/Execution provenance. Explain evidence in the body where applicable.",
  "input_schema": {
    "type": "object",
    "required": [
      "content"
    ],
    "properties": {
      "content": {},
      "title": {
        "type": "string",
        "maxLength": 120
      },
      "summary": {
        "type": "string",
        "maxLength": 500
      },
      "media_type": {
        "type": "string"
      },
      "receiving_task_id": {
        "type": "string"
      },
      "used_material_ids": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "string"
        }
      },
      "attachments": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "media_type": {
              "type": "string"
            },
            "content_base64": {
              "type": "string"
            },
            "content_hash": {
              "type": "string"
            },
            "source": {
              "type": "object",
              "required": [
                "material_id",
                "attachment_name"
              ],
              "properties": {
                "material_id": {
                  "type": "string"
                },
                "attachment_name": {
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        }
      },
      "supersedes": {
        "type": "string"
      },
      "expected_version": {
        "type": "integer",
        "minimum": 0
      },
      "supersede_reason": {
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
    "when": "Publish immutable research content and optional attachments with current Task/Execution provenance. Explain evidence in the body where applicable.",
    "ref": "service://context/context_publish_material",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Publish immutable research content and optional attachments with current Task/Execution provenance. Explain evidence in the body where applicable.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
  "manifest_hash": "34476ca30e7dfd2fa5ee3d63e04d69a4b2acdee2ca9fd13a4667543105a7a497"
}
```

#### judge.judge_workspace_check

Build a fixed public Lean Workspace revision when project checking is configured. An optional path identifies a checked delivery file. Legacy single-file checkers require a path.

```json
{
  "name": "judge_workspace_check",
  "operation": "workspace_check",
  "description": "Build a fixed public Lean Workspace revision when project checking is configured. An optional path identifies a checked delivery file. Legacy single-file checkers require a path.",
  "input_schema": {
    "type": "object",
    "required": [
      "revision"
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
    "when": "Build a fixed public Lean Workspace revision when project checking is configured. An optional path identifies a checked delivery file. Legacy single-file checkers require a path.",
    "ref": "service://judge/workspace_check",
    "text": "Purpose: Workspace source checking and structured CheckResults.\nUse when: Build a fixed public Lean Workspace revision when project checking is configured. An optional path identifies a checked delivery file. Legacy single-file checkers require a path.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
  "context": [],
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

#### Catalog context.context_publish / publish_material

```json
{
  "name": "context_publish",
  "service": "context",
  "operation": "publish_material",
  "version": "1.0",
  "description": "Publish a versioned shared Material for other Executions.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
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

Registry matches are resolved first by capability name or operation and must be unique. Only when no Registry match exists does the local router use these exact fallback sets. The historical Task source-binding entry records a Workspace source without performing a check; registered Bots invoke Judge directly through the Registry. The fallback Judge set contains result retrieval. Unlisted operations fail with no service route.

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
  "task_cancel",
  "task_dependency_replace",
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
  "BOT_STARTUP_CONTRACT": "BOT_STARTUP_CONTRACT",
  "WORKSPACE_BUSY": "WORKSPACE_BUSY",
  "WORKSPACE_RECONCILIATION_REQUIRED": "WORKSPACE_RECONCILIATION_REQUIRED",
  "WORKSPACE_REQUEST_ABORTED": "WORKSPACE_REQUEST_ABORTED",
  "WORKSPACE_RESULT_UNKNOWN": "WORKSPACE_RESULT_UNKNOWN",
  "MAIN_MOVED": "MAIN_MOVED",
  "MISSION_SUBMITTING": "MISSION_SUBMITTING",
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
