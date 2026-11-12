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
| [src/sdk/service-catalog.js](../../src/sdk/service-catalog.js) | `730a2dcb46b2d536eef98f0167b136ade8a23b39eb329efade56ddf91d94568c` |
| [src/sdk/builtin-registry.js](../../src/sdk/builtin-registry.js) | `028ca5e7a5f3aba59da19b2d2863dffad49d9fd52a14a451ae45c10e39fe0266` |
| [src/sdk/service-manifest.js](../../src/sdk/service-manifest.js) | `415bf40c46e284fbd5ad52fc5f7c96266003edb5573dba3a55c734966b9e01bf` |
| [src/sdk/service-registry.js](../../src/sdk/service-registry.js) | `6528826cb1e89980159bc23150e6f18162df54ac3f9eb5eda264befb6160dc46` |
| [src/agent/capability-profile.js](../../src/agent/capability-profile.js) | `860472091ce4673b581a495909ad7bfdddbabcf8ae80954c18e8d4ecee176422` |
| [src/agent/services-bridge.js](../../src/agent/services-bridge.js) | `1eb6721de10dad2c26b6de914ff14983d7ea618c56924294bed63448ce94b9a2` |
| [src/sdk/services-sdk.js](../../src/sdk/services-sdk.js) | `e7c5fcf6d45d15c433d5ed349d4c9c7e8a2818317a1dba3742b1566d07a7ab29` |
| [src/sdk/service-router.js](../../src/sdk/service-router.js) | `73a873ab891b530dd1e287b1131aaeed8423a70bca851d1adc8fb32113f000c0` |
| [src/runtime/runtime-capabilities.js](../../src/runtime/runtime-capabilities.js) | `4bffe717abd7837ded6f953123c22359aa7d693c747b775363c6dd5b66f2ddb5` |
| [src/benchmark/putnam-runner.js](../../src/benchmark/putnam-runner.js) | `1c57a483b89bac5270e62b8a2f0de1b9960f4a565ef9a4fc46aa69f282316f83` |
| [services/mathlib-search/service.json](../../services/mathlib-search/service.json) | `616a349bea3dc7282f26a90a3c8882d06afe846c58fdbf00a851404546c15b70` |
| [src/errors.js](../../src/errors.js) | `eedbc3e6869e525c16369ca1aca042d12bdc0877a3f4447be4319f23e54e3ddc` |

### Exact tool exposure for the built-in benchmark

The four columns apply the benchmark's current Task-model and Sandbox filters. Optional registered Services add capabilities. Both built-in `bound` and `recovery` roles currently have the same named surface. Presence in this table does not bypass the Bridge's Task/Execution binding, modern-retired-operation or Workspace-contract checks. `swarmenv_` is the Pi extension prefix.

| Capability identity | flat; Sandbox off | flat; Sandbox on | legacy; Sandbox off | legacy; Sandbox on |
|---|---|---|---|---|
| `catalog.catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` | `swarmenv_catalog_get_service_metadata` |
| `catalog.catalog_list_services` | `swarmenv_catalog_list_services` | `swarmenv_catalog_list_services` | `swarmenv_catalog_list_services` | `swarmenv_catalog_list_services` |
| `catalog.catalog_list_tools` | `swarmenv_catalog_list_tools` | `swarmenv_catalog_list_tools` | `swarmenv_catalog_list_tools` | `swarmenv_catalog_list_tools` |
| `context.context_consume` | `swarmenv_context_consume` | `swarmenv_context_consume` | `swarmenv_context_consume` | `swarmenv_context_consume` |
| `context.context_get_material` | `swarmenv_context_get_material` | `swarmenv_context_get_material` | `swarmenv_context_get_material` | `swarmenv_context_get_material` |
| `context.context_publish` | `swarmenv_context_publish` | `swarmenv_context_publish` | `swarmenv_context_publish` | `swarmenv_context_publish` |
| `context.context_publish_material` | `swarmenv_context_publish_material` | `swarmenv_context_publish_material` | `swarmenv_context_publish_material` | `swarmenv_context_publish_material` |
| `context.context_read` | `swarmenv_context_read` | `swarmenv_context_read` | `swarmenv_context_read` | `swarmenv_context_read` |
| `context.context_search_materials` | `swarmenv_context_search_materials` | `swarmenv_context_search_materials` | `swarmenv_context_search_materials` | `swarmenv_context_search_materials` |
| `judge.judge_get_check_result` | `swarmenv_judge_get_check_result` | `swarmenv_judge_get_check_result` | `swarmenv_judge_get_check_result` | `swarmenv_judge_get_check_result` |
| `judge.judge_submit_candidate` | `swarmenv_judge_submit_candidate` | `swarmenv_judge_submit_candidate` | `swarmenv_judge_submit_candidate` | `swarmenv_judge_submit_candidate` |
| `runtime.execution_get` | `swarmenv_execution_get` | `swarmenv_execution_get` | `swarmenv_execution_get` | `swarmenv_execution_get` |
| `runtime.sandbox_exec` | Absent | `swarmenv_sandbox_exec` | Absent | `swarmenv_sandbox_exec` |
| `runtime.sandbox_job` | Absent | `swarmenv_sandbox_job` | Absent | `swarmenv_sandbox_job` |
| `runtime.task_block` | Absent | Absent | `swarmenv_runtime_task_block` | `swarmenv_runtime_task_block` |
| `runtime.task_complete` | Absent | Absent | `swarmenv_runtime_task_complete` | `swarmenv_runtime_task_complete` |
| `runtime.workspace_diff` | `swarmenv_workspace_diff` | `swarmenv_workspace_diff` | `swarmenv_workspace_diff` | `swarmenv_workspace_diff` |
| `runtime.workspace_get` | `swarmenv_workspace_get` | `swarmenv_workspace_get` | `swarmenv_workspace_get` | `swarmenv_workspace_get` |
| `runtime.workspace_list_files` | `swarmenv_workspace_list_files` | `swarmenv_workspace_list_files` | `swarmenv_workspace_list_files` | `swarmenv_workspace_list_files` |
| `runtime.workspace_read_file` | `swarmenv_workspace_read_file` | `swarmenv_workspace_read_file` | `swarmenv_workspace_read_file` | `swarmenv_workspace_read_file` |
| `runtime.workspace_write_file` | `swarmenv_workspace_write_file` | `swarmenv_workspace_write_file` | `swarmenv_workspace_write_file` | `swarmenv_workspace_write_file` |
| `task.execution_progress` | `swarmenv_execution_progress` | `swarmenv_execution_progress` | `swarmenv_execution_progress` | `swarmenv_execution_progress` |
| `task.task_block` | `swarmenv_task_block` | `swarmenv_task_block` | `swarmenv_task_task_block` | `swarmenv_task_task_block` |
| `task.task_close` | `swarmenv_task_close` | `swarmenv_task_close` | `swarmenv_task_close` | `swarmenv_task_close` |
| `task.task_complete` | `swarmenv_task_complete` | `swarmenv_task_complete` | `swarmenv_task_task_complete` | `swarmenv_task_task_complete` |
| `task.task_create` | `swarmenv_task_create` | `swarmenv_task_create` | `swarmenv_task_create` | `swarmenv_task_create` |
| `task.task_create_child` | `swarmenv_task_create_child` | `swarmenv_task_create_child` | `swarmenv_task_create_child` | `swarmenv_task_create_child` |
| `task.task_discover` | `swarmenv_task_discover` | `swarmenv_task_discover` | `swarmenv_task_discover` | `swarmenv_task_discover` |
| `task.task_feedback` | `swarmenv_task_feedback` | `swarmenv_task_feedback` | `swarmenv_task_feedback` | `swarmenv_task_feedback` |
| `task.task_link_material` | `swarmenv_task_link_material` | `swarmenv_task_link_material` | `swarmenv_task_link_material` | `swarmenv_task_link_material` |
| `task.task_list` | `swarmenv_task_list` | `swarmenv_task_list` | `swarmenv_task_list` | `swarmenv_task_list` |
| `task.task_register` | `swarmenv_task_register` | `swarmenv_task_register` | `swarmenv_task_register` | `swarmenv_task_register` |
| `task.task_status` | `swarmenv_task_status` | `swarmenv_task_status` | `swarmenv_task_status` | `swarmenv_task_status` |
| `task.task_take` | `swarmenv_task_take` | `swarmenv_task_take` | `swarmenv_task_take` | `swarmenv_task_take` |
| `task.task_view` | `swarmenv_task_view` | `swarmenv_task_view` | `swarmenv_task_view` | `swarmenv_task_view` |

`task_create_child` remains advertised by the built-in Registry, but a bound Mission Task is explicitly forbidden from calling `create_child_task`. `task_handoff` is retained in the catalog/SDK but excluded from the normal built-in Registry; the normal handoff tool is `execution_progress` with `kind: "handoff"`. These are current implementation details, not proposed changes.

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

### Task Service: 14 registered capabilities

Exact normalized built-in manifest metadata:

```json
{
  "manifest_version": "1",
  "service_id": "task",
  "id": "task",
  "title": "Task Service",
  "purpose": "Durable Task goals, claims, structure, and completion evidence.",
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
  "manifest_hash": "71569528f619cba6d2db7632208a05036497350439796e2133535004f005c8ef"
}
```

#### task.task_discover

Discover the bounded Mission Task view and relevant shared work.

```json
{
  "name": "task_discover",
  "operation": "list_tasks",
  "description": "Discover the bounded Mission Task view and relevant shared work.",
  "input_schema": {
    "type": "object",
    "properties": {
      "root_id": {
        "type": "string"
      },
      "states": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "task_type": {
        "type": "string"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "available_only": {
        "type": "boolean"
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
    "when": "Discover the bounded Mission Task view and relevant shared work.",
    "ref": "service://task/list_tasks",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Discover the bounded Mission Task view and relevant shared work.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/list_tasks",
  "errors": []
}
```

#### task.task_create_child

Create a bounded direct child Task for a genuinely separate responsibility.

```json
{
  "name": "task_create_child",
  "operation": "create_child_task",
  "description": "Create a bounded direct child Task for a genuinely separate responsibility.",
  "input_schema": {
    "type": "object",
    "required": [
      "child_creation_key",
      "task_type",
      "goal",
      "expected_output",
      "acceptance_conditions"
    ],
    "properties": {
      "child_creation_key": {
        "type": "string"
      },
      "task_type": {
        "type": "string"
      },
      "goal": {
        "type": "string"
      },
      "expected_output": {
        "type": "string"
      },
      "acceptance_conditions": {
        "type": "object"
      },
      "priority": {
        "type": "integer",
        "minimum": 0
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
    "when": "Create a bounded direct child Task for a genuinely separate responsibility.",
    "ref": "service://task/create_child_task",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Create a bounded direct child Task for a genuinely separate responsibility.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/create_child_task",
  "errors": []
}
```

#### task.task_status

Read the authoritative Mission, Task counts, claimable work, and observation timestamp.

```json
{
  "name": "task_status",
  "operation": "task_status",
  "description": "Read the authoritative Mission, Task counts, claimable work, and observation timestamp.",
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
    "when": "Read the authoritative Mission, Task counts, claimable work, and observation timestamp.",
    "ref": "service://task/task_status",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Read the authoritative Mission, Task counts, claimable work, and observation timestamp.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_status",
  "errors": []
}
```

#### task.task_register

Register one independent Task with a goal, output, acceptance condition, and collaboration reason. With take: true the current Execution is checkpointed and ended and the new Task is taken on the same Core lane in one operation, so no other Agent can take it first; without take the Task is left open for others.

```json
{
  "name": "task_register",
  "operation": "task_register",
  "description": "Register one independent Task with a goal, output, acceptance condition, and collaboration reason. With take: true the current Execution is checkpointed and ended and the new Task is taken on the same Core lane in one operation, so no other Agent can take it first; without take the Task is left open for others.",
  "input_schema": {
    "type": "object",
    "required": [
      "mission_id",
      "goal",
      "expected_output",
      "acceptance_conditions"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "task_id": {
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
      "collaboration_reason": {
        "type": "string"
      },
      "responsibility_key": {
        "type": "string"
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
      },
      "take": {
        "type": "boolean"
      },
      "progress": {
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
    "when": "Register one independent Task with a goal, output, acceptance condition, and collaboration reason. With take: true the current Execution is checkpointed and ended and the new Task is taken on the same Core lane in one operation, so no other Agent can take it first; without take the Task is left open for others.",
    "ref": "service://task/task_register",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Register one independent Task with a goal, output, acceptance condition, and collaboration reason. With take: true the current Execution is checkpointed and ended and the new Task is taken on the same Core lane in one operation, so no other Agent can take it first; without take the Task is left open for others.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_register",
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
      "claim_key": {
        "type": "string"
      },
      "workspace_mode": {
        "type": "string",
        "enum": [
          "resume",
          "clean"
        ]
      },
      "workspace_revision": {
        "type": "integer",
        "minimum": 1
      },
      "workspace_source_execution_id": {
        "type": "string"
      },
      "workspace_source_ref": {
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Take an existing Mission or ordinary Task using the caller identity and Core lane.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Record this Execution's durable decision and action for delivered feedback; another Execution may retain its own handling state.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Save a bounded Progress Material and either continue the current Execution or hand it off.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: List Mission Tasks and search their short summaries before proposing new work.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Read one Task, its two relations, state, current Execution, and linked Materials.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Create one substantial ordinary Task with a summary, expected output, acceptance condition, and optional relations.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Link an immutable Material to a Task with an input, response, handoff, or experience role.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_link_material",
  "errors": []
}
```

#### task.task_complete

Complete the current Task when its own contract and required Material or Judge evidence are satisfied.

```json
{
  "name": "task_complete",
  "operation": "task_complete",
  "description": "Complete the current Task when its own contract and required Material or Judge evidence are satisfied.",
  "input_schema": {
    "type": "object",
    "properties": {
      "material_ids": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "check_result_id": {
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
    "when": "Complete the current Task when its own contract and required Material or Judge evidence are satisfied.",
    "ref": "service://task/task_complete",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Complete the current Task when its own contract and required Material or Judge evidence are satisfied.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_complete",
  "errors": []
}
```

#### task.task_block

Publish and link Handoff Material, record a typed Task or capability dependency, and end the current Execution. An ordinary Task becomes BLOCKED; the shared Mission Task stays claimable and only this Execution ends.

```json
{
  "name": "task_block",
  "operation": "task_block",
  "description": "Publish and link Handoff Material, record a typed Task or capability dependency, and end the current Execution. An ordinary Task becomes BLOCKED; the shared Mission Task stays claimable and only this Execution ends.",
  "input_schema": {
    "type": "object",
    "required": [
      "blocker",
      "dependency",
      "handoff_material_id"
    ],
    "properties": {
      "blocker": {
        "type": "object"
      },
      "dependency": {
        "type": "object",
        "minProperties": 1,
        "description": "Use dependency_kind TASK with prerequisite_task_id for a Task prerequisite, or CAPABILITY with capability_id for a missing runtime/external capability. On an ordinary Task, capability blockers remain durably BLOCKED until an explicit reopen after the recovery condition is met. A capability listed among this Session tools is callable and is rejected as a blocker.",
        "properties": {
          "dependency_kind": {
            "type": "string",
            "enum": [
              "TASK",
              "CAPABILITY"
            ]
          },
          "prerequisite_task_id": {
            "type": "string"
          },
          "capability_id": {
            "type": "string"
          },
          "scope": {
            "type": "string"
          },
          "retryable": {
            "type": "boolean"
          },
          "recovery_condition": {
            "type": "string"
          }
        }
      },
      "handoff_material_id": {
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
    "when": "Publish and link Handoff Material, record a typed Task or capability dependency, and end the current Execution. An ordinary Task becomes BLOCKED; the shared Mission Task stays claimable and only this Execution ends.",
    "ref": "service://task/task_block",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Publish and link Handoff Material, record a typed Task or capability dependency, and end the current Execution. An ordinary Task becomes BLOCKED; the shared Mission Task stays claimable and only this Execution ends.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_block",
  "errors": []
}
```

#### task.task_close

Accept a linked Response Material from another Task and close its producer.

```json
{
  "name": "task_close",
  "operation": "task_close",
  "description": "Accept a linked Response Material from another Task and close its producer.",
  "input_schema": {
    "type": "object",
    "required": [
      "producer_task_id",
      "material_id"
    ],
    "properties": {
      "producer_task_id": {
        "type": "string"
      },
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
  "side_effect": "write",
  "idempotent": false,
  "context": [
    "task",
    "execution"
  ],
  "requires_binding": false,
  "scope": "task-write",
  "help": {
    "when": "Accept a linked Response Material from another Task and close its producer.",
    "ref": "service://task/task_close",
    "text": "Purpose: Durable Task goals, claims, structure, and completion evidence.\nUse when: Accept a linked Response Material from another Task and close its producer.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_close",
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
  "manifest_hash": "ba3d09a5fb7c784fae88a886b2a0c59df05a89f61c5185223255c2ef03fca729"
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

Record which bounded shared Material IDs this Execution used for a route, task, candidate, or integration action.

```json
{
  "name": "context_consume",
  "operation": "consume_materials",
  "description": "Record which bounded shared Material IDs this Execution used for a route, task, candidate, or integration action.",
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
          "candidate",
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
    "when": "Record which bounded shared Material IDs this Execution used for a route, task, candidate, or integration action.",
    "ref": "service://context/consume_materials",
    "text": "Purpose: Versioned shared Materials and provenance.\nUse when: Record which bounded shared Material IDs this Execution used for a route, task, candidate, or integration action.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
  "purpose": "Candidate checking and structured CheckResults.",
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
  "manifest_hash": "131cb61f301a801a3bdf93d502988fb4705bbf88ac5975abf46fd56fe1bc715b"
}
```

#### judge.judge_submit_candidate

Submit a Workspace answer file to Judge for compilation and checking. The returned CheckResult separates source-level PASS/FAIL from checker infrastructure_failure and unassessed outcomes.

```json
{
  "name": "judge_submit_candidate",
  "operation": "submit_candidate",
  "description": "Submit a Workspace answer file to Judge for compilation and checking. The returned CheckResult separates source-level PASS/FAIL from checker infrastructure_failure and unassessed outcomes.",
  "input_schema": {
    "type": "object",
    "required": [
      "path"
    ],
    "properties": {
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
    "when": "Submit a Workspace answer file to Judge for compilation and checking. The returned CheckResult separates source-level PASS/FAIL from checker infrastructure_failure and unassessed outcomes.",
    "ref": "service://judge/submit_candidate",
    "text": "Purpose: Candidate checking and structured CheckResults.\nUse when: Submit a Workspace answer file to Judge for compilation and checking. The returned CheckResult separates source-level PASS/FAIL from checker infrastructure_failure and unassessed outcomes.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/submit_candidate",
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
    "required": [
      "check_result_id"
    ],
    "properties": {
      "check_result_id": {
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
    "text": "Purpose: Candidate checking and structured CheckResults.\nUse when: Read a Judge CheckResult, checker process status, result class, retryability, and diagnostic feedback.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/get_check_result",
  "errors": []
}
```

### Runtime-owned capabilities

These declarations are merged into a Session profile after deployment filtering. They are not registered HTTP providers. Most Runtime output schemas are empty strict-object placeholders; they do not enumerate the actual return fields described in the narrative chapters.

#### runtime.task_complete

```json
{
  "id": "runtime.task_complete",
  "name": "task_complete",
  "operation": "accept_task",
  "service_id": "runtime",
  "service_title": "SwarmEnv Runtime",
  "service_purpose": "Task-scoped completion and dependency actions",
  "description": "Complete the current Task after its own contract and result references are satisfied.",
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
    "when": "Use after the current Task completion contract is satisfied and evidence is persisted.",
    "ref": "runtime://task_complete"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "target_task_id": {
        "type": "string",
        "minLength": 1
      },
      "target_state_version": {
        "type": "integer",
        "minimum": 0
      }
    },
    "required": [
      "target_task_id"
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

#### runtime.task_block

```json
{
  "id": "runtime.task_block",
  "name": "task_block",
  "operation": "task_block",
  "service_id": "runtime",
  "service_title": "SwarmEnv Runtime",
  "service_purpose": "Task-scoped completion and dependency actions",
  "description": "Save a useful checkpoint, declare a typed dependency, and release this Execution. An ordinary Task becomes BLOCKED; the shared Mission Task stays claimable.",
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
    "when": "Use only when the current Task cannot progress without a concrete typed dependency.",
    "ref": "runtime://task_block"
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "minLength": 1
      },
      "dependency": {
        "type": "object",
        "minProperties": 1
      },
      "checkpoint": {
        "type": "object"
      },
      "files": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      }
    },
    "required": [
      "reason",
      "dependency"
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
  "description": "Run a bounded shell command inside the current Execution Sandbox. The private Workspace is mounted at /workspace; shell edits become durable only after execution_progress saves them.",
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

#### Catalog task.task_create_branch_group / create_branch_group

```json
{
  "name": "task_create_branch_group",
  "service": "task",
  "operation": "create_branch_group",
  "version": "1.0",
  "description": "Create a versioned group of alternative ordinary Tasks. Branch membership expresses alternatives; it does not create an implicit wait, ownership, or execution dependency, and the creating Task may continue useful work.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "parent_task_id",
      "branch_tasks"
    ],
    "properties": {
      "parent_task_id": {
        "type": "string"
      },
      "branch_tasks": {
        "type": "array",
        "items": {
          "type": "object"
        }
      },
      "group_key": {
        "type": "string"
      },
      "expected_structural_version": {
        "type": "integer",
        "minimum": 0
      }
    },
    "additionalProperties": true
  }
}
```

#### Catalog task.task_add_required_subtask / add_required_subtask

```json
{
  "name": "task_add_required_subtask",
  "service": "task",
  "operation": "add_required_subtask",
  "version": "1.0",
  "description": "Add an ordinary Task as a jointly required subtask. Required subtasks may become ready concurrently; only an explicit execution dependency blocks work, and provenance remains audit information.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "owner_task_id"
    ],
    "properties": {
      "owner_task_id": {
        "type": "string"
      },
      "subtask_task_id": {
        "type": "string"
      },
      "subtask": {
        "type": "object"
      },
      "expected_structural_version": {
        "type": "integer",
        "minimum": 0
      }
    },
    "additionalProperties": true
  }
}
```

#### Catalog task.task_get_structure / get_task_structure

```json
{
  "name": "task_get_structure",
  "service": "task",
  "operation": "get_task_structure",
  "version": "1.0",
  "description": "Inspect a Task structure in one view: alternative branches, jointly required subtasks, explicit execution dependencies, creation provenance, completion status, unresolved work, and structural version.",
  "scope": "task-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog task.task_propose_structure_change / propose_structure_change

```json
{
  "name": "task_propose_structure_change",
  "service": "task",
  "operation": "propose_structure_change",
  "version": "1.0",
  "description": "Propose an auditable, version-checked Task structure change based on new evidence. Structural membership, explicit execution dependencies, and creation provenance stay distinct; active work is preserved.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "task_id",
      "change"
    ],
    "properties": {
      "task_id": {
        "type": "string"
      },
      "expected_structural_version": {
        "type": "integer",
        "minimum": 0
      },
      "change": {
        "type": "object"
      },
      "change_key": {
        "type": "string"
      }
    },
    "additionalProperties": true
  }
}
```

#### Catalog task.task_explain_readiness / explain_task_readiness

```json
{
  "name": "task_explain_readiness",
  "service": "task",
  "operation": "explain_task_readiness",
  "version": "1.0",
  "description": "Explain why a Task is READY, BLOCKED, or SATISFIED, including missing contract evidence and explicit dependencies; branch alternatives and required subtasks are not generic waits.",
  "scope": "task-read",
  "side_effect": false,
  "parameters": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog task.task_create_rework / create_rework_task

```json
{
  "name": "task_create_rework",
  "service": "task",
  "operation": "create_rework_task",
  "version": "1.0",
  "description": "Create a new rework Task linked to a prior deliverable, feedback, Materials, and Workspace lineage. Rework reuses prior evidence through explicit provenance and does not silently reopen the old Execution.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "prior_task_id"
    ],
    "properties": {
      "prior_task_id": {
        "type": "string"
      },
      "instruction": {
        "type": "string"
      },
      "feedback": {},
      "input_material_refs": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "workspace_source_execution_id": {
        "type": "string"
      },
      "workspace_revision": {
        "type": "integer",
        "minimum": 1
      }
    },
    "additionalProperties": true
  }
}
```

#### Catalog task.task_accept / accept_task

```json
{
  "name": "task_accept",
  "service": "task",
  "operation": "accept_task",
  "version": "1.0",
  "description": "Complete a Task whose own completion contract is satisfied. A parent review is required only when the target contract explicitly sets parent_review=true; otherwise the current Task owner may accept its own work after reading the evidence.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "target_task_id"
    ],
    "properties": {
      "target_task_id": {
        "type": "string"
      },
      "target_state_version": {
        "type": "integer",
        "minimum": 0
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog task.task_request_rework / request_rework

```json
{
  "name": "task_request_rework",
  "service": "task",
  "operation": "request_rework",
  "version": "1.0",
  "description": "Send a child Task back for focused rework with a durable steer Material. The child must be WAITING for parent_review; leave OPEN or RUNNING children with their worker.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "target_task_id",
      "instruction"
    ],
    "properties": {
      "target_task_id": {
        "type": "string"
      },
      "instruction": {
        "type": "string"
      },
      "scope": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog task.task_handoff / task_handoff

```json
{
  "name": "task_handoff",
  "service": "task",
  "operation": "task_handoff",
  "version": "1.0",
  "description": "Publish and link Handoff Material, then return unfinished work to the Mission queue.",
  "scope": "task-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "handoff_material_id"
    ],
    "properties": {
      "handoff_material_id": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

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

#### Catalog execution.execution_heartbeat / heartbeat

```json
{
  "name": "execution_heartbeat",
  "service": "execution",
  "operation": "heartbeat",
  "version": "1.0",
  "description": "Extend the current Execution lease.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "properties": {
      "lease_expires_at": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog execution.execution_wait / request_wait

```json
{
  "name": "execution_wait",
  "service": "execution",
  "operation": "request_wait",
  "version": "1.0",
  "description": "Save a checkpoint and release the active Execution for a durable Task dependency wait. Use child_task_terminal, a non-empty children_all_terminal set, parent_review, or timer. Candidate submission is synchronous and returns its CheckResult; do not wait for a candidate.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "wait_condition"
    ],
    "properties": {
      "wait_condition": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string"
          },
          "child_task_id": {
            "type": "string"
          },
          "check_request_key": {
            "type": "string"
          },
          "candidate_material_id": {
            "type": "string"
          },
          "deadline": {
            "type": "string"
          }
        },
        "additionalProperties": true
      },
      "checkpoint": {
        "type": "object"
      },
      "files": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
      },
      "wait_deadline": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

#### Catalog execution.execution_block / block_execution

```json
{
  "name": "execution_block",
  "service": "execution",
  "operation": "block_execution",
  "version": "1.0",
  "description": "Save a checkpoint, end the current Execution, release its Core, and mark the Task BLOCKED for a concrete external dependency. Use this instead of leaving a live Execution in WAITING.",
  "scope": "execution-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "reason",
      "dependency"
    ],
    "properties": {
      "reason": {
        "type": "string"
      },
      "dependency": {
        "type": "object",
        "properties": {
          "dependency_kind": {
            "type": "string",
            "enum": [
              "TASK",
              "MATERIAL",
              "CHECK_RESULT"
            ]
          },
          "prerequisite_task_id": {
            "type": "string"
          },
          "material_id": {
            "type": "string"
          },
          "check_result_id": {
            "type": "string"
          },
          "requirement": {
            "type": "object"
          }
        },
        "additionalProperties": false
      },
      "checkpoint": {
        "type": "object"
      },
      "files": {
        "type": "object",
        "additionalProperties": {
          "type": "string"
        }
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
| `getTask` | `get_task` | read |
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
| `completeTask` | `task_complete` | write |
| `closeTask` | `task_close` | write |
| `handoffTask` | `task_handoff` | write |
| `blockTask` | `task_block` | write |
| `listClaimableTasks` | `list_claimable_tasks` | read |
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
| `proposeTask` | `propose_task` | write |
| `taskRegister` | `task_register` | write |
| `createChildTask` | `create_child_task` | write |
| `createBranchGroup` | `create_branch_group` | write |
| `addRequiredSubtask` | `add_required_subtask` | write |
| `getTaskStructure` | `get_task_structure` | read |
| `proposeStructureChange` | `propose_structure_change` | write |
| `explainTaskReadiness` | `explain_task_readiness` | read |
| `createReworkTask` | `create_rework_task` | write |
| `claim` | `claim` | write |
| `taskTake` | `task_take` | write |
| `taskFeedback` | `task_feedback` | write |
| `executionProgress` | `execution_progress` | write |
| `heartbeat` | `heartbeat` | write |
| `requestWait` | `request_wait` | write |
| `submitCandidate` | `submit_candidate` | write |
| `acceptTask` | `accept_task` | write |
| `requestRework` | `request_rework` | write |
| `applyCheckResult` | `apply_check_result` | write |
| `wakeExecution` | `wake_execution` | write |
| `publishMaterial` | `publish_material` | write |
| `abort` | `abort` | write |
| `startExecution` | `start_execution` | write |
| `resumeExecution` | `resume_execution` | write |
| `stopExecution` | `stop_execution` | write |
| `fenceExecution` | `fence_execution` | write |

### Complete local router fallback sets

Registry matches are resolved first by capability name or operation and must be unique. Only when no Registry match exists does the local router use these exact fallback sets. Candidate submission belongs to Task here; only result retrieval belongs directly to Judge. Unlisted operations fail with no service route.

#### TASK fallback operations

```json
[
  "abort",
  "claim",
  "create_child_task",
  "fence_execution",
  "get_execution",
  "get_task",
  "heartbeat",
  "list_children",
  "list_tasks",
  "list_claimable_tasks",
  "list_executions",
  "propose_task",
  "request_wait",
  "resume_execution",
  "start_execution",
  "stop_execution",
  "submit_candidate",
  "accept_task",
  "request_rework",
  "apply_check_result",
  "wake_execution",
  "create_branch_group",
  "add_required_subtask",
  "get_task_structure",
  "propose_structure_change",
  "explain_task_readiness",
  "create_rework_task",
  "create_mission",
  "get_mission",
  "create_task",
  "list_task",
  "view_task",
  "task_list",
  "task_view",
  "task_create",
  "task_status",
  "task_register",
  "task_take",
  "task_feedback",
  "execution_progress",
  "link_material",
  "task_link_material",
  "list_task_materials",
  "task_materials",
  "complete_task",
  "task_complete",
  "close_task",
  "task_close",
  "handoff_task",
  "task_handoff",
  "block_task_semantic",
  "task_block"
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
  "list_material_consumptions"
]
```

#### JUDGE fallback operations

```json
[
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
