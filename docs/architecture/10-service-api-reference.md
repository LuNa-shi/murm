# 10. Complete Service and capability reference

This inventory lists the repository-controlled API declarations for this tree. The services chapter explains request handling, durable state changes, Runtime intervention and failure behavior. [Services](04-services.md) · [Source coverage](12-code-coverage.md)

A JSON Schema in a manifest is a declared contract. This implementation validates manifest shape at registration and passes input schemas to Pi, but the Registry/HTTP host do **not** run a general JSON Schema validator on every input or output. Domain handlers perform their own validation. In particular, an empty Runtime output schema or the built-in “any JSON value” output schema is not a complete description of the result. The narrative and storage reference supply the missing implementation detail.

## How to read an entry

| Field | Meaning in this implementation |
|---|---|
| `name` / `operation` | Named capability and dispatched handler operation. The Pi tool name is `murm_` followed by the profile's disambiguated `tool_name`. |
| `audience` | Which Session roles may see/call it; currently `bound` and `recovery`. |
| `context` | Context needed by Bridge; non-catalog registered operations with nonempty context normally require a current Task/Execution, except taking a Task. |
| `requires_binding` | Additional binding check enforced by Registry and HTTP host, used by Mathlib Search. |
| `idempotent` | Manifest declaration. Durable Task/Context replay uses the operation ID and entire request fingerprint; this flag alone does not implement replay. |
| `input_schema` / `output_schema` | Full advertised schemas, including required fields, unions, enums, limits and openness. |
| `help` | Complete registered usage text/ref. Whether the full text reaches a particular prompt is documented in [08 Prompts](08-prompts.md). |
| `errors` | Declared error list; built-in manifests use an empty list even though handlers can return domain errors. The complete shared vocabulary is reproduced below. |
| `method` / `path` | HTTP route for a hosted provider. In-process adapters use the same capability identity without an HTTP request. |

## Updating this reference

After changing catalogs, capability selection, manifests, schemas or error vocabulary, run `node dist/scripts/generate-architecture-api.js` and review the generated differences. `node dist/scripts/generate-architecture-api.js --check` detects stale generated content without changing it. A successful check detects declaration drift; it does not prove that the explanatory text or runtime behavior is correct.

Internal Services use `MurmError`. The former class/helper exports and the diagnostic error name `MurmError` remain for consumers of the previous names. Structured error codes are listed below.

<!-- BEGIN GENERATED REFERENCE -->

## Generated API inventory

This section is generated from executable exports and checked against the source hashes below. It contains declarations; call-time behavior and known differences are explained in [Services](04-services.md), [Mission and Task](03-mission-task.md), and [Workspace](05-workspace-continuity.md).

| Source | SHA-256 |
|---|---|
| [examples/taskpool/services/service-catalog.ts](../../examples/taskpool/services/service-catalog.ts) | `34da62ab9a42462e3a08837efa890009b1bfb4ca4bfb961319c2369cbb1df01d` |
| [examples/taskpool/services/builtin-registry.ts](../../examples/taskpool/services/builtin-registry.ts) | `095a61e9242fcc37d88bf18758881b280317b8040a8c38a0fc8cac41aa894306` |
| [examples/taskpool/deploy/service-hosts/service-manifest.ts](../../examples/taskpool/deploy/service-hosts/service-manifest.ts) | `78fcddbe31f5e2a01aa8702e88d5d15fd0e99d8e6da9809a4755f8530214d02c` |
| [examples/taskpool/deploy/service-hosts/service-registry.ts](../../examples/taskpool/deploy/service-hosts/service-registry.ts) | `3c74387987c657134699ad39b160f415d7537a21f8e3dffd0b2b298bcd8f27aa` |
| [test-support/taskpool-legacy/capability-profile.ts](../../test-support/taskpool-legacy/capability-profile.ts) | `8ff9b1fdcdb4a31421dbb59939a09d381db4de84c13a1b417593b46a533b65c5` |
| [test-support/taskpool-legacy/services-bridge.ts](../../test-support/taskpool-legacy/services-bridge.ts) | `bddb5744b172e34d5939b958f5e92946f736d6816b31c9b54938976ded8e1ca6` |
| [examples/services/mathlib-search/service.json](../../examples/services/mathlib-search/service.json) | `c205c3f97119aa171299ce664b40c8c68f0d5a6e88b4938b07e49dd7dd18066f` |
| [src/errors.ts](../../src/errors.ts) | `5b436c6d7062a7b9fb0fd434af1375b9c050999cfa76bd6d97dac88558dca8b3` |
| [src/core/index.ts](../../src/core/index.ts) | `7e0ce37b7296edf002f95d6b0c0d7e11b5059f513fe26aa52f07c7356ee6992d` |
| [src/core/types.ts](../../src/core/types.ts) | `40541748e91eb4890f32954c0627d6e3ce2d69fc2dc4f5bbafedbb52d7d5c30b` |
| [src/core/services.ts](../../src/core/services.ts) | `794352ccfa8e02f63c4db087f1c165308198c6766c0d8c3cf8872e1b9c0617ab` |
| [src/core/service-types.ts](../../src/core/service-types.ts) | `e602451c72d58182266255ac9b0e856541f23b7221a931b7beaaffe486909e37` |
| [src/core/sandbox/opensandbox-backend.ts](../../src/core/sandbox/opensandbox-backend.ts) | `6c2538a3b833a1e35f202e75acacef872b0d6d1863209c81671db72f3a70f19d` |
| [src/core/sandbox/executor-driver.ts](../../src/core/sandbox/executor-driver.ts) | `182e80680d8ea6e1729d524a6927d800a91caffd3657ed796706ebaad9d28131` |
| [src/core/backend-config.ts](../../src/core/backend-config.ts) | `be1c5c7db4876f5632f6f855af3e16e8f59c46a5a76b3f27a934508e15cbdf47` |
| [src/core/sandbox/opensandbox-provider.ts](../../src/core/sandbox/opensandbox-provider.ts) | `eb98901a846c1ce294621d7a173cec46787ba4bf18b4edc65afc5c867e968c37` |
| [src/core/sandbox/sandbox-connection.ts](../../src/core/sandbox/sandbox-connection.ts) | `2f7337b6fcbfd9f3df6735dfdf42be0d8f06b4c732963b21d4cdbd331b2f9249` |

### Exact built-in command operation surface

Agents use native Bash to invoke typed swarm commands. Registry declarations below describe authorized domain operations; no additional Pi tool registration is installed. Optional Services extend the Registry.

| Capability identity | Service | Operation |
|---|---|---|
| `catalog.catalog_get_service_metadata` | `catalog` | `get_service_metadata` |
| `catalog.catalog_list_services` | `catalog` | `list_services` |
| `catalog.catalog_list_tools` | `catalog` | `list_tools` |
| `context.consume_materials` | `context` | `consume_materials` |
| `context.context_get_material` | `context` | `context_get_material` |
| `context.context_publish_material` | `context` | `context_publish_material` |
| `context.context_search_materials` | `context` | `context_search_materials` |
| `context.material_dispute` | `context` | `material_dispute` |
| `context.material_supersede` | `context` | `material_supersede` |
| `context.material_unsupersede` | `context` | `material_unsupersede` |
| `context.read_materials` | `context` | `read_materials` |
| `judge.judge_get_check_result` | `judge` | `get_check_result` |
| `judge.judge_workspace_check` | `judge` | `workspace_check` |
| `task.agent_exit` | `task` | `agent_exit` |
| `task.mission_get` | `task` | `mission_get` |
| `task.mission_submission_get` | `task` | `mission_submission_get` |
| `task.mission_submit` | `task` | `mission_submit` |
| `task.task_cancel` | `task` | `task_cancel` |
| `task.task_dependency_replace` | `task` | `task_dependency_replace` |
| `task.task_feedback` | `task` | `task_feedback` |
| `task.task_finish` | `task` | `task_finish` |
| `task.task_link_material` | `task` | `task_link_material` |
| `task.task_list` | `task` | `task_list` |
| `task.task_revise` | `task` | `task_revise` |
| `task.task_status` | `task` | `task_status` |
| `task.task_take` | `task` | `task_take` |
| `task.task_view` | `task` | `task_view` |
| `task.workspace_current_diff` | `task` | `workspace_current_diff` |
| `task.workspace_merge` | `task` | `workspace_merge` |
| `task.workspace_public_diff` | `task` | `workspace_public_diff` |
| `task.workspace_public_files` | `task` | `workspace_public_files` |
| `task.workspace_public_history` | `task` | `workspace_public_history` |
| `task.workspace_public_read` | `task` | `workspace_public_read` |
| `task.workspace_public_search` | `task` | `workspace_public_search` |
| `task.workspace_public_view` | `task` | `workspace_public_view` |
| `task.workspace_save` | `task` | `workspace_save` |
| `task.workspace_status` | `task` | `workspace_status` |

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
  "manifest_hash": "804b836fdab0271635e356e1094d1d5e8ddc6d6240cee2b9f9c32abd9aa41cac"
}
```

#### catalog.catalog_list_services

List every available murm Service and its tool count.

```json
{
  "name": "catalog_list_services",
  "operation": "list_services",
  "description": "List every available murm Service and its tool count.",
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
    "when": "List every available murm Service and its tool count.",
    "ref": "service://catalog/list_services",
    "text": "Purpose: Role-scoped Service and capability discovery.\nUse when: List every available murm Service and its tool count.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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

### Task Service: 24 registered capabilities

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
  "manifest_hash": "fe83cedd8d96df5f0ff48ab7a4b1e0940bb4200817470b08e87184bbc27ec0c7"
}
```

#### task.agent_exit

End this unbound Agent after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.

```json
{
  "name": "agent_exit",
  "operation": "agent_exit",
  "description": "End this unbound Agent after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.",
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
    "when": "End this unbound Agent after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.",
    "ref": "service://task/agent_exit",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: End this unbound Agent after finding no useful work or exhausting its selection budget. Runtime releases the Core after confirmed cleanup.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/agent_exit",
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

Take an existing Task in this Mission using the caller Agent and Core.

```json
{
  "name": "task_take",
  "operation": "task_take",
  "description": "Take an existing Task in this Mission using the caller Agent and Core.",
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
    "when": "Take an existing Task in this Mission using the caller Agent and Core.",
    "ref": "service://task/task_take",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Take an existing Task in this Mission using the caller Agent and Core.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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

#### task.task_list

Search bounded Task summaries across states; follow next_cursor and read Task detail before taking work.

```json
{
  "name": "task_list",
  "operation": "task_list",
  "description": "Search bounded Task summaries across states; follow next_cursor and read Task detail before taking work.",
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
    "when": "Search bounded Task summaries across states; follow next_cursor and read Task detail before taking work.",
    "ref": "service://task/task_list",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Search bounded Task summaries across states; follow next_cursor and read Task detail before taking work.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_list",
  "errors": []
}
```

#### task.task_view

Read a Task contract, gap and priority, dependencies, Executions and Materials. Continue contract history using contract_history_page.next_after_version.

```json
{
  "name": "task_view",
  "operation": "task_view",
  "description": "Read a Task contract, gap and priority, dependencies, Executions and Materials. Continue contract history using contract_history_page.next_after_version.",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "string"
      },
      "contract_history_after_version": {
        "type": "integer",
        "minimum": 0
      },
      "contract_history_limit": {
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
    "when": "Read a Task contract, gap and priority, dependencies, Executions and Materials. Continue contract history using contract_history_page.next_after_version.",
    "ref": "service://task/task_view",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Read a Task contract, gap and priority, dependencies, Executions and Materials. Continue contract history using contract_history_page.next_after_version.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_view",
  "errors": []
}
```

#### task.task_revise

An UNBOUND Agent may revise an open, unowned Task in its Mission, including previously executed work. Supply observed contract/state versions and a reason. Running, preparing, cleaning up and closed responsibilities are protected; old Executions retain their original contract.

```json
{
  "name": "task_revise",
  "operation": "task_revise",
  "description": "An UNBOUND Agent may revise an open, unowned Task in its Mission, including previously executed work. Supply observed contract/state versions and a reason. Running, preparing, cleaning up and closed responsibilities are protected; old Executions retain their original contract.",
  "input_schema": {
    "type": "object",
    "required": [
      "task_id",
      "expected_spec_version",
      "expected_state_version",
      "reason",
      "changes"
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
        "type": "string",
        "minLength": 1
      },
      "changes": {
        "type": "object",
        "minProperties": 1,
        "properties": {
          "summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 240
          },
          "gap": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "expected_output": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "acceptance_conditions": {
            "oneOf": [
              {
                "type": "array",
                "minItems": 1
              },
              {
                "type": "object",
                "minProperties": 1
              }
            ]
          },
          "priority": {
            "oneOf": [
              {
                "type": "string",
                "enum": [
                  "high",
                  "medium",
                  "low"
                ]
              },
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 2
              }
            ]
          },
          "depends_on": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "input_material_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 100
          },
          "workspace": {
            "type": "object"
          },
          "base_revision": {
            "type": "string",
            "pattern": "^[0-9]+[.][0-9]+$"
          },
          "task_instructions": {
            "type": "string"
          }
        },
        "additionalProperties": false
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
    "when": "An UNBOUND Agent may revise an open, unowned Task in its Mission, including previously executed work. Supply observed contract/state versions and a reason. Running, preparing, cleaning up and closed responsibilities are protected; old Executions retain their original contract.",
    "ref": "service://task/task_revise",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: An UNBOUND Agent may revise an open, unowned Task in its Mission, including previously executed work. Supply observed contract/state versions and a reason. Running, preparing, cleaning up and closed responsibilities are protected; old Executions retain their original contract.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
  },
  "method": "POST",
  "path": "/v1/task_revise",
  "errors": []
}
```

#### task.task_link_material

Link an immutable Material to a Task. For a response, use the receiving Task as task_id; the authenticated Execution supplies the producer. An input link targets the current Task.

```json
{
  "name": "task_link_material",
  "operation": "task_link_material",
  "description": "Link an immutable Material to a Task. For a response, use the receiving Task as task_id; the authenticated Execution supplies the producer. An input link targets the current Task.",
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
        "type": "string",
        "description": "For a response this field is optional and must equal task_id when provided."
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
    "when": "Link an immutable Material to a Task. For a response, use the receiving Task as task_id; the authenticated Execution supplies the producer. An input link targets the current Task.",
    "ref": "service://task/task_link_material",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: Link an immutable Material to a Task. For a response, use the receiving Task as task_id; the authenticated Execution supplies the producer. An input link targets the current Task.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
      "wait_for": {
        "type": "string"
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

An UNBOUND Agent may cancel an open, unowned Task in its Mission using observed versions and a reason. Historical contracts remain readable; cancellation does not satisfy dependencies.

```json
{
  "name": "task_cancel",
  "operation": "task_cancel",
  "description": "An UNBOUND Agent may cancel an open, unowned Task in its Mission using observed versions and a reason. Historical contracts remain readable; cancellation does not satisfy dependencies.",
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
    "when": "An UNBOUND Agent may cancel an open, unowned Task in its Mission using observed versions and a reason. Historical contracts remain readable; cancellation does not satisfy dependencies.",
    "ref": "service://task/task_cancel",
    "text": "Purpose: Durable Task goals, takes, structure, and completion evidence.\nUse when: An UNBOUND Agent may cancel an open, unowned Task in its Mission using observed versions and a reason. Historical contracts remain readable; cancellation does not satisfy dependencies.\nInputs follow the registered schema. The response is the adapter's structured JSON result. Errors are authoritative and must be handled or retried only as documented by the returned error code."
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
      "producer_task_id": {
        "type": "string"
      },
      "producer_execution_id": {
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
  "manifest_hash": "5185c188b03c5327bca01a9653f18a4ed364b88326243ddbdd1024b460e17a23"
}
```

#### context.read_materials

List one page of shared Material summaries. Use an exact Material ID to read its complete content.

```json
{
  "name": "read_materials",
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
      "producer_task_id": {
        "type": "string"
      },
      "producer_execution_id": {
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

#### context.consume_materials

Record which bounded shared Material IDs this Execution used for a route, Task, Workspace source, or integration action.

```json
{
  "name": "consume_materials",
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
      "producer_task_id": {
        "type": "string"
      },
      "producer_execution_id": {
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
  "manifest_hash": "21ea5bda4e91d3c46e7221d5d617ac9a3653d7ffefa0614e08c496903d81bafd"
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
      "check_mode": {
        "type": "string",
        "enum": [
          "lean-project",
          "lean-module"
        ]
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
    "token": "env:MURM_MATHLIB_SEARCH_TOKEN"
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

### Internal catalog entries

This section records catalog declarations used by trusted service composition but not exposed as Agent operations. It is not an authorization list for the Agent.

#### Catalog task.task_create / task_create

```json
{
  "name": "task_create",
  "service": "task",
  "operation": "task_create",
  "version": "1.0",
  "description": "Propose one independently useful responsibility with a short summary, Mission gap, output, completion conditions and explicit high/medium/low priority. Agent proposals require explicit Harness registration and current Mission authority. Optional base_revision pins input; otherwise take uses main.",
  "scope": "task-write",
  "side_effect": true,
  "parameters": {
    "type": "object",
    "required": [
      "summary",
      "gap",
      "expected_output",
      "acceptance_conditions",
      "priority"
    ],
    "properties": {
      "mission_id": {
        "type": "string"
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 240
      },
      "gap": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "expected_output": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "acceptance_conditions": {
        "oneOf": [
          {
            "type": "array",
            "minItems": 1
          },
          {
            "type": "object",
            "minProperties": 1
          }
        ]
      },
      "priority": {
        "oneOf": [
          {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ]
          },
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 2
          }
        ]
      },
      "depends_on": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "input_material_refs": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        },
        "maxItems": 100
      },
      "workspace": {
        "type": "object",
        "description": "Compatibility input. If both workspace.revision and base_revision are supplied, they must match."
      },
      "base_revision": {
        "type": "string",
        "pattern": "^[0-9]+[.][0-9]+$"
      },
      "task_instructions": {
        "type": "string"
      },
      "goal": {
        "type": "string"
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
      "responsibility_key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "timebox_ms": {
        "type": "integer",
        "minimum": 1
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
  "AGENT_STARTUP_CONTRACT": "AGENT_STARTUP_CONTRACT",
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

### Core public declarations

These are the package entrypoint declarations and the declarations they reference. [Core Runtime](15-core-runtime.md) describes the executable contracts and limits.

#### dist/src/core/index.d.ts

```ts
import type { CreateRuntimeOptions, RecoverRuntimeOptions, Runtime } from './types.js';
export type * from './session-types.js';
export { createHarnessSession } from '../harness/project-harness.js';
export type { HarnessInput, HarnessInputHandler, HarnessInputPreparation, HarnessJson, HarnessStatusInfo, ProjectHarness, ProjectHarnessContext, ProjectHarnessResult, } from '../harness/project-harness.js';
export type { HarnessAgentHandler, HarnessAgentReceipt, HarnessAgentRegistration, HarnessAgents, HarnessAnswer, HarnessAnswerReceipt, HarnessCapability, HarnessDescriptor, HarnessEvent, HarnessInputDescriptor, HarnessInputReceipt, HarnessLifetime, HarnessOperation, HarnessPhase, HarnessQuestion, HarnessQuestionKind, HarnessQuestionRequest, HarnessQuestionSource, HarnessRequest, HarnessResult, HarnessSession, HarnessSessionOptions, HarnessStartReceipt, HarnessState, HarnessStopReceipt, } from '../harness/harness-session-types.js';
export { ProjectPreflightError } from '../harness/project-input.js';
export { HarnessRpcClient } from '../harness/project-rpc-client.js';
export type { HarnessRpcClientOptions, HarnessRpcReady, HarnessRpcTransport } from '../harness/project-rpc-client.js';
export { observeProjectRuntime, projectConfiguration, projectResult } from '../harness/project-runtime.js';
export { runInput, type RunInputResult } from '../harness/run-input.js';
export { runWithReport } from '../harness/run-report.js';
export { readHarnessResult } from '../harness/read-result.js';
export { createInputAdmission } from '../harness/input-admission.js';
export { createOwnedResources } from '../harness/owned-resources.js';
export { httpClient } from '../harness/http.js';
export { checkGitProject, seedTeamRepository, seededCheckoutInstruction } from '../harness/project-git.js';
export { initializeGitRepository, importGitTree, commitGitTree, isGitTreePath } from '../harness/git-tree.js';
export { decodeFileSeed as decodeFileTree, snapshotFileSeed as snapshotFileTree, completeDigest as completeFileTreeDigest } from './files/core-file-seed.js';
export { MurmError } from '../errors.js';
export { requestHttp } from '../protocol/http-request.js';
export { stableStringify } from '../protocol/stable-json.js';
export { createSandbox } from './sandbox/opensandbox-backend.js';
export { resolveSandboxConnection } from './sandbox/sandbox-connection.js';
export { createCodexExecutor, createExecutorAdapter, createPiExecutor, getExecutorCapabilities } from './sandbox/executor-driver.js';
export { EXECUTOR_ADAPTER_PROTOCOL } from './executor-adapter.js';
export type { BuiltinExecutorSelection, ExecutorAdapter, ExecutorSelection } from './executor-adapter.js';
export { DEFAULT_WORKER_IMAGE, workerImageFor } from './worker-image.js';
export { ServiceRegistry, createInProcessAdapter, createHttpJsonAdapter } from './services.js';
export type { ExecutorCapabilities, ExecutorKind, ModelConfig, RuntimeConnectionOptions, Sandbox, SandboxConfig, SandboxProviderConfig, SteeringMode } from './backend-config.js';
export type { ModelCapabilities, ModelProtocol, ModelStreamTerminal, ModelTransport } from './model/model-transport.js';
export type { FileBudget, FilePolicy } from './file-policy.js';
export type { OperationLimits } from './operation-queue.js';
export type { SandboxPreparation, SandboxProvider } from './sandbox/opensandbox-provider.js';
export type { SandboxManager } from './sandbox/opensandbox-backend.js';
export type { HttpJsonAdapterOptions, ServiceRegistration } from './services.js';
export type { JsonValue, ServiceAdapter, ServiceCaller, ServiceCapability, ServiceManifest, ServiceRequest } from './service-types.js';
export type { AgentAccess, AgentAccessGrant, AgentAccessMutation, AgentAccessPolicy, AgentAccessRequest, AgentInfo, AgentInitialInputResult, AgentListFilter, AgentSpawnReceipt, AgentStatus, CloseOptions, CloseReceipt, CollectionSpec, CompleteFileDigest, CompleteFileSnapshot, CompleteFileSnapshotOptions, ConditionalInputReceipt, CreateRuntimeOptions, RecoverRuntimeOptions, ErrorInfo, FileEntry, FileReplaceOptions, FileReplaceReceipt, FileSnapshot, FileSnapshotOptions, FileTree, InputMode, InputReceipt, InterruptOptions, InterruptReceipt, PartialFileDigest, PartialFileSnapshot, PendingCleanup, Profile, ProfileDefinition, ProfileRegistration, ResourceError, Runtime, RuntimeEvent, RuntimeFiles, RuntimeManagementChange, RuntimeManagementSnapshot, RuntimeServiceDefinition, RuntimeServiceRegistration, RuntimeState, SendOptions, ServiceRetirement, SpawnOptions, StopOptions, StopReceipt, WorkspaceOptions, } from './types.js';
export declare function createRuntime(options: CreateRuntimeOptions): Promise<Runtime>;
export declare function recoverRuntime(options: RecoverRuntimeOptions): Promise<Runtime>;
```

#### dist/src/core/types.d.ts

```ts
import type { OperationLimits } from './operation-queue.js';
import type { ModelConfig, RuntimeConnectionOptions, Sandbox, SteeringMode } from './backend-config.js';
import type { ExecutorSelection } from './executor-adapter.js';
import type { FilePolicy } from './file-policy.js';
import type { ServiceRegistration, ServiceRegistry } from './services.js';
import type { ServiceManifest } from './service-types.js';
import type { AgentSessionConfig, ContextInput, ContextInputReceipt, ContextSendOptions, RuntimeHooks, RuntimeSession, SessionEvent } from './session-types.js';
export {};
export interface Profile {
    session?: AgentSessionConfig;
    /** Optional Harness instructions added to the standard startup prompt. */
    prompt?: string;
    model: string;
    image: string;
    writable: boolean;
    services: Readonly<Record<string, readonly string[]>>;
    spawnProfiles?: readonly string[];
    allowContextFork?: boolean;
    env?: Readonly<Record<string, string>>;
    network?: {
        allow: readonly string[];
    };
    collect?: CollectionSpec;
}
export interface CreateRuntimeOptions {
    sandbox: Sandbox;
    executor?: ExecutorSelection;
    filePolicy?: FilePolicy;
    models: Readonly<Record<string, ModelConfig>>;
    connection?: RuntimeConnectionOptions;
    profiles: Readonly<Record<string, Profile>>;
    services: ServiceRegistry;
    maxAgents: number;
    outputDir: string;
    agentAccessPolicy?: AgentAccessPolicy;
    hooks?: RuntimeHooks;
    operationLimits?: OperationLimits;
    persistence?: {
        deploymentId: string;
        contract: string;
        retainForMs?: number;
    };
}
export interface RecoverRuntimeOptions extends CreateRuntimeOptions {
    runDirectory: string;
    cleanupOnly?: boolean;
    restoreService?(definition: RuntimeServiceDefinition): Promise<ServiceRegistration | undefined>;
}
export interface FileEntry {
    readonly encoding: 'utf8' | 'base64';
    readonly data: string;
    readonly mode?: 0o644 | 0o755;
}
export type FileTree = Readonly<Record<string, FileEntry>>;
export type CompleteFileDigest = `complete:sha256:${string}`;
export type PartialFileDigest = `partial:sha256:${string}`;
export interface FileSnapshotOptions {
    requestId: string;
    paths: readonly string[];
    maxBytes?: number;
}
export interface CompleteFileSnapshotOptions extends FileSnapshotOptions {
    paths: readonly ['.'];
}
export interface CompleteFileSnapshot {
    readonly agentId: string;
    readonly requestId: string;
    readonly version: number;
    readonly files: FileTree;
    readonly scope: 'complete';
    readonly digest: CompleteFileDigest;
}
export interface PartialFileSnapshot {
    readonly agentId: string;
    readonly requestId: string;
    readonly version: number;
    readonly files: FileTree;
    readonly scope: 'partial';
    readonly digest: PartialFileDigest;
}
export type FileSnapshot = CompleteFileSnapshot | PartialFileSnapshot;
export interface FileReplaceOptions {
    requestId: string;
    expectedDigest: CompleteFileDigest;
    files: FileTree;
    writable?: true;
}
export type FileReplaceReceipt = {
    readonly agentId: string;
    readonly requestId: string;
} & ({
    readonly status: 'completed';
    readonly digest: CompleteFileDigest;
    readonly writable: boolean;
} | {
    readonly status: 'failed';
    readonly error: ErrorInfo;
} | {
    readonly status: 'unknown';
});
export interface CollectionSpec {
    paths: readonly string[];
    includeGit: boolean;
    allowMissingGit?: boolean;
    maxBytes: number;
    required: boolean;
}
export type WorkspaceOptions = {
    id: string;
    mode: 'read-only' | 'read-write';
};
export interface SpawnOptions {
    session?: AgentSessionConfig;
    forkFrom?: string;
    requestId: string;
    profile: string;
    parentId?: string;
    writable?: boolean;
    files?: FileTree;
    bindings?: Readonly<Record<string, string>>;
    secretEnv?: Readonly<Record<string, string>>;
    workspace?: WorkspaceOptions;
    collect?: CollectionSpec;
}
export interface ErrorInfo {
    code: string;
    message: string;
    retryable: boolean;
}
export interface ResourceError extends Error {
    code: string;
    operation: string;
    runtimeId?: string;
    agentId?: string;
    requestId?: string;
    cleanup: 'complete' | 'pending';
    reportPath?: string;
    details: readonly ErrorInfo[];
}
export type AgentStatus = 'starting' | 'idle' | 'running' | 'exited' | 'closing' | 'closed';
export interface AgentListFilter {
    parentId?: string | null;
    status?: AgentStatus | readonly AgentStatus[];
}
export interface AgentInfo {
    id: string;
    profile: string;
    parentId?: string;
    status: AgentStatus;
    latestOutput?: string;
    lastError?: ErrorInfo;
    lastStop?: StopReceipt;
}
export type InputMode = 'steer' | 'followUp';
export interface SendOptions {
    requestId: string;
    mode?: InputMode;
    source?: string;
    steeringMode?: SteeringMode;
    wakeIfIdle?: boolean;
}
export type InputReceipt = {
    inputId: string;
    status: 'accepted';
    disposition: 'started' | 'queued' | 'handled';
} | {
    inputId: string;
    status: 'unknown';
};
export type ConditionalInputReceipt = InputReceipt | {
    inputId: string;
    status: 'not-accepted';
    reason: 'idle';
};
export interface InterruptReceipt {
    interruptId: string;
    status: 'interrupted' | 'unknown';
    discardedInputHashes?: readonly string[];
}
export type AgentInitialInputResult = InputReceipt | {
    status: 'rejected';
    error: ErrorInfo;
} | null;
/** Built-in agent.spawn Service result, distinct from host Runtime.spawn. */
export interface AgentSpawnReceipt {
    agent: AgentInfo;
    initialInput: AgentInitialInputResult;
}
export type AgentEvent = {
    agentId: string;
} & ({
    type: 'workerProbe';
    requestId: string;
} | SessionEvent | {
    type: 'output';
    text: string;
} | {
    type: 'settled';
    outcome: 'completed' | 'failed' | 'aborted';
    output?: string;
    error?: ErrorInfo;
} | {
    type: 'error';
    error: ErrorInfo;
    fatal: boolean;
} | {
    type: 'exit';
    reason: string;
    expected: boolean;
});
export type RuntimeEvent = AgentEvent | {
    type: 'agentChanged';
    agentId: string;
} | {
    type: 'runtimeChanged';
} | {
    type: 'subscriberGap';
    dropped: number;
} | {
    type: 'management';
    change: RuntimeManagementChange;
};
export type RuntimeState = 'open' | 'closing' | 'closed';
export interface InterruptOptions {
    requestId: string;
    timeoutMs?: number;
}
export interface StopOptions {
    timeoutMs?: number;
}
export interface CloseOptions {
    timeoutMs?: number;
}
export interface PendingCleanup {
    kind: 'agent' | 'bridge' | 'model' | 'backend' | 'report' | 'service';
    id: string;
    action: 'await-startup' | 'stop-execution' | 'archive-session' | 'collect-artifacts' | 'delete-sandbox' | 'close' | 'save' | 'retire-service';
    error?: ErrorInfo;
    resourceKey?: string;
    providerId?: string;
    sandboxId?: string;
    creation?: 'created' | 'pending' | 'absent';
    executionStopped?: boolean;
    expiresAt?: string | null;
    retention?: {
        reason: 'archive-session' | 'collect-artifacts';
        status: 'retained' | 'retain-at-risk';
        autoRenewing: boolean;
        deadline?: string;
        owner?: string;
    };
}
export interface StopReceipt {
    agentId: string;
    execution: 'stopped' | 'unknown';
    cleanup: 'complete' | 'pending';
    artifacts: readonly string[];
    sessionArchive?: string;
    errors: readonly ErrorInfo[];
    pending?: PendingCleanup;
}
export interface CloseReceipt {
    agents: readonly StopReceipt[];
    cleanup: 'complete' | 'pending';
    errors: readonly ErrorInfo[];
    pending: readonly PendingCleanup[];
    outputDir: string;
    reportPath?: string;
    evidence: {
        path?: string;
        recorded: number;
        lost: number;
        pending: number;
    };
}
export interface ProfileRegistration {
    readonly actorId?: string;
    readonly id: string;
    readonly requestId: string;
    readonly profile: Profile;
}
export interface ProfileDefinition {
    readonly actorId?: string;
    readonly id: string;
    readonly digest: string;
    readonly sequence: number;
    readonly profile: Profile;
}
export interface RuntimeServiceRegistration {
    readonly actorId?: string;
    readonly requestId: string;
    readonly registration: ServiceRegistration;
    readonly deploymentRef: string;
    readonly implementationId: string;
    readonly ownership: 'run' | 'external';
}
export interface ServiceRetirement {
    readonly actorId?: string;
    readonly serviceId: string;
    readonly requestId: string;
    readonly timeoutMs?: number;
}
export interface RuntimeServiceDefinition {
    readonly actorId?: string;
    readonly id: string;
    readonly manifest: ServiceManifest;
    readonly sequence: number;
    readonly state: 'ready' | 'retiring' | 'retired';
    readonly deploymentRef?: string;
    readonly implementationId?: string;
    readonly ownership?: RuntimeServiceRegistration['ownership'];
    readonly error?: ErrorInfo;
}
export type AgentAccessRequest = {
    readonly runtimeId: string;
    readonly callerId: string;
    readonly agentId: string;
} & ({
    readonly operation: 'access_get';
} | {
    readonly operation: 'grant' | 'revoke';
    readonly serviceId: string;
    readonly operations: readonly string[];
});
export type AgentAccessPolicy = (request: AgentAccessRequest) => boolean;
export interface AgentAccess {
    readonly agentId: string;
    readonly version: number;
    readonly services: Readonly<Record<string, readonly string[]>>;
}
export interface AgentAccessMutation {
    readonly agentId: string;
    readonly serviceId: string;
    readonly operations: readonly string[];
    readonly requestId: string;
}
export type AgentAccessGrant = AgentAccessMutation & {
    readonly binding?: string;
};
export interface RuntimeManagementSnapshot {
    readonly recoveryBlockedServices?: readonly string[];
    readonly sequence: number;
    readonly profiles: readonly ProfileDefinition[];
    readonly services: readonly RuntimeServiceDefinition[];
    readonly access: readonly AgentAccess[];
}
export type RuntimeManagementChange = {
    readonly sequence: number;
    readonly caller: string;
    readonly requestId: string;
} & ({
    readonly operation: 'profile.register';
    readonly definition: ProfileDefinition;
} | {
    readonly operation: 'service.register' | 'service.retire';
    readonly definition: RuntimeServiceDefinition;
} | {
    readonly operation: 'access.grant' | 'access.revoke';
    readonly access: AgentAccess;
    readonly serviceId: string;
    readonly operations: readonly string[];
});
export interface Runtime {
    readonly id: string;
    readonly state: RuntimeState;
    diagnostics(): {
        renewing: number;
        eventReads: number;
        pendingSubscriberCallbacks: number;
        queues: Record<'prepare' | 'stop' | 'transfer' | 'reconcile', {
            active: number;
            queued: number;
        }>;
    };
    readonly session: RuntimeSession;
    spawn(options: SpawnOptions): Promise<AgentInfo>;
    get(agentId: string): Promise<AgentInfo>;
    list(filter?: AgentListFilter): Promise<AgentInfo[]>;
    interrupt(agentId: string, options: InterruptOptions): Promise<InterruptReceipt>;
    probeWorkerEvent(agentId: string, options: {
        requestId: string;
        timeoutMs?: number;
    }): Promise<{
        requestId: string;
        elapsedMs: number;
    }>;
    send(agentId: string, input: string, options: SendOptions & {
        wakeIfIdle?: true;
    }): Promise<InputReceipt>;
    send(agentId: string, input: string, options: SendOptions): Promise<ConditionalInputReceipt>;
    send(agentId: string, input: ContextInput, options: ContextSendOptions): Promise<ContextInputReceipt>;
    onEvent(handler: (event: RuntimeEvent) => void | Promise<void>): () => void;
    stop(agentId: string, options?: StopOptions): Promise<StopReceipt>;
    close(options?: CloseOptions): Promise<CloseReceipt>;
    readonly profiles: {
        register(input: ProfileRegistration): Promise<ProfileDefinition>;
        get(id: string): ProfileDefinition | null;
        list(): readonly ProfileDefinition[];
    };
    readonly access: {
        get(agentId: string): AgentAccess | null;
        grant(input: AgentAccessGrant): Promise<AgentAccess>;
        revoke(input: AgentAccessMutation): Promise<AgentAccess>;
    };
    readonly services: {
        register(input: RuntimeServiceRegistration): Promise<RuntimeServiceDefinition>;
        get(id: string): RuntimeServiceDefinition | null;
        list(): readonly RuntimeServiceDefinition[];
        retire(input: ServiceRetirement): Promise<RuntimeServiceDefinition>;
    };
    readonly management: {
        get(): RuntimeManagementSnapshot;
    };
    readonly files: RuntimeFiles;
}
export interface RuntimeFiles {
    snapshot(agentId: string, options: CompleteFileSnapshotOptions): Promise<CompleteFileSnapshot>;
    snapshot(agentId: string, options: FileSnapshotOptions): Promise<FileSnapshot>;
    replace(agentId: string, options: FileReplaceOptions): Promise<FileReplaceReceipt>;
}
```

#### dist/src/core/services.d.ts

```ts
import type { JsonValue, ServiceManifest, ServiceCaller, ServiceAdapter } from './service-types.js';
export type * from './service-types.js';
export interface ServiceRegistration {
    manifest: ServiceManifest;
    adapter: ServiceAdapter;
}
export interface AdapterMetadata {
    transport: 'http-json';
    timeoutMs: number;
}
export interface ServiceInvocation {
    operation: string;
    input: unknown;
    envelope: {
        operation_id: string;
    };
    caller: ServiceCaller;
    signal?: AbortSignal;
    recordService?: (record: ServiceInvocationRecord) => void;
    assertAuthorized?: () => void;
    trackCompletion?: (completion: Promise<void>) => void;
}
export interface ServiceInvocationRecord {
    /** One Bridge HTTP attempt, independent of the logical operation identity. */
    attemptId?: string;
    accessVersion?: number;
    runtimeId: string;
    agentId: string;
    profile: string;
    serviceId: string;
    operation: string;
    operationId: string;
    state: string;
    outcome: string;
    error?: {
        code: string;
        retryable: boolean;
    };
}
/** Register host authentication material with the private trace redactor. */
export declare function registerServicePrivateValues(registrations: ReadonlyMap<string, ServiceRegistration>, register: (values: readonly string[]) => void): void;
/** Internal non-credential effective adapter configuration for run evidence. */
export declare function getAdapterMetadata(adapter: ServiceAdapter): Readonly<AdapterMetadata> | undefined;
export declare function isJson(value: unknown, seen?: Set<object>, depth?: number): value is JsonValue;
export declare class ServiceRegistry {
    constructor();
    registerService(registration: ServiceRegistration): void;
}
export declare function builtinAgentRegistration(manifest: ServiceManifest, adapter: ServiceAdapter): Readonly<ServiceRegistration>;
export declare function createInProcessAdapter(implementation: ServiceAdapter): ServiceAdapter;
export declare function snapshotServiceRegistration(registration: ServiceRegistration): Readonly<ServiceRegistration>;
export declare function snapshotServiceRegistry(services: ServiceRegistry): Map<string, Readonly<ServiceRegistration>>;
export declare function invokeService(registration: ServiceRegistration, { operation, input, envelope, caller, signal, recordService, assertAuthorized, trackCompletion }: ServiceInvocation, timeoutMs?: number): Promise<JsonValue>;
/** Host-configured HTTP adapter. Its credential never enters Agent environments. */
export interface HttpJsonAdapterOptions {
    token?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
export declare function createHttpJsonAdapter({ token, timeoutMs, fetchImpl }?: HttpJsonAdapterOptions): ServiceAdapter;
```

#### dist/src/core/service-types.d.ts

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface ServiceManifest {
    id: string;
    title: string;
    purpose: string;
    provider_version: string;
    contract_version: '2';
    endpoint: {
        transport: 'in-process';
    } | {
        transport: 'http-json';
        url: string;
    };
    capabilities: readonly ServiceCapability[];
}
export interface ServiceCapability {
    name: string;
    operation: string;
    description: string;
    side_effect: 'read' | 'write';
    idempotent: boolean;
    help: {
        when: string;
        ref?: string;
    };
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    errors: readonly {
        code: string;
        retryable: boolean;
    }[];
    path?: string;
    /** Host-registered invocation deadline, 1..86400000 ms. Defaults to 30000. */
    timeout_ms?: number;
}
export interface ServiceCaller {
    runtimeId: string;
    agentId: string;
    profile: string;
    binding?: string;
}
export interface ServiceRequest {
    manifest: ServiceManifest;
    capability: ServiceCapability;
    input: JsonValue;
    envelope: {
        operation_id: string;
        [key: string]: unknown;
    };
    caller: ServiceCaller;
    signal: AbortSignal;
    /** Recheck caller authority immediately before a Service commits its side effect. */
    assertAuthorized(): void;
}
export interface ServiceAdapter {
    invoke(request: ServiceRequest): JsonValue | Promise<JsonValue>;
    /** Host confirmation that an uncertain HTTP write cannot continue to change remote state. */
    confirmQuiescent?(options: {
        signal: AbortSignal;
    }): boolean | Promise<boolean>;
    /** Optional bounded host-only snapshot called during retirement or Runtime close. */
    exportState?(options: {
        signal: AbortSignal;
    }): JsonValue | Promise<JsonValue>;
}
```

#### dist/src/core/sandbox/opensandbox-backend.d.ts

```ts
import type { AllocationLedger, AllocationRecord as LedgerAllocation } from '../allocation-ledger.js';
import type { BeforeCompactDecision, BeforeCompactRequest } from '../session-types.js';
import type { AgentEvent, ErrorInfo, InputMode, InterruptReceipt, Profile, SpawnOptions, SendOptions } from '../types.js';
import type { SessionFork } from '../../../scripts/core-session-fork.js';
import type { createCoreBridge } from '../bridge.js';
import { type createCoreModelAccess } from '../model/model-access.js';
import { type ResolvedFilePolicy } from '../file-policy.js';
export type BackendEvent = {
    [Kind in AgentEvent['type']]: Omit<Extract<AgentEvent, {
        type: Kind;
    }>, 'agentId'>;
}[AgentEvent['type']];
export type BackendInputReceipt = {
    status: 'unknown';
    reason: string;
} | {
    status: 'not-accepted';
    reason: 'idle';
} | {
    status: 'accepted';
    disposition: 'started' | 'queued' | 'handled';
};
interface InputSubmission {
    input: string;
    mode: InputMode;
    wakeIfIdle: boolean;
    first: boolean;
    receipt?: Exclude<BackendInputReceipt, {
        status: 'unknown';
    }>;
    work?: Promise<BackendInputReceipt>;
}
type SharedWorkspace = Extract<NonNullable<SpawnOptions['workspace']>, {
    id: string;
}>;
import type { WorkerFileReplace, WorkerFileSnapshot } from '../file-controls.js';
import type { FileReplaceOptions, FileSnapshotOptions } from '../types.js';
interface BackendAgent {
    workspace?: SharedWorkspace;
    id: string;
    provider: OpenSandboxProvider;
    manager: SandboxManager;
    onEvent(event: BackendEvent): void;
    onExecutionStart?: () => void;
    beforeCompact?: {
        timeoutMs: number;
        handler(request: Omit<BeforeCompactRequest, 'agentId' | 'profile' | 'signal'>): Promise<BeforeCompactDecision>;
    };
    onTrace?: (record: Readonly<Record<string, unknown>>) => void;
    cursor: number;
    output: string;
    error: ErrorInfo | null;
    outcome?: 'completed' | 'failed' | 'aborted';
    stopping: boolean;
    exited: boolean;
    eventPoll: ReturnType<typeof createWorkerEventPoll>;
    nativeExecuting: boolean;
    pendingInputs: number;
    historyLost?: boolean;
    started?: boolean;
    executionEpoch?: number;
    sessionReady?: boolean;
    loadedResources?: readonly unknown[];
    activeMessageId?: string;
    sessionCommands?: Map<string, {
        fingerprint: string;
        command: string;
    }>;
    decisions?: Set<string>;
    workerStartDispatched?: boolean;
    polling?: Promise<void>;
    submissions?: Map<string, InputSubmission>;
    executionStopped?: boolean;
    lease?: {
        expiresAt: string | null;
        dueAt: number;
        work?: Promise<void>;
    };
    retaining?: 'archive-session' | 'collect-artifacts';
    retainAtRisk?: boolean;
    retainUntil?: string;
    deleting?: boolean;
    workerIdentity?: {
        workerInstanceId: string;
        streamEpoch: string;
    };
    recovery?: () => Promise<void>;
    uncertain?: boolean;
}
type WorkerRecord = {
    worker_sequence: number;
    worker_at?: string;
    [key: string]: any;
} & ({
    type: 'message_end';
    message: {
        role: string;
        content?: {
            type: string;
            text: string;
        }[];
        stopReason?: string;
        errorMessage?: string;
    };
} | {
    type: 'controller_probe';
    traceId: string;
} | {
    type: 'worker_error';
    message: string;
} | {
    type: 'worker_exit';
    code?: string | number;
    signal?: string;
} | {
    type: 'agent_start' | 'agent_settled';
    aborted?: boolean;
} | {
    type: 'message_start' | 'message_update' | 'core_before_compact' | 'core_before_compact_result' | 'core_context_disposition' | 'core_session_event' | 'core_session_ready' | 'compaction_start' | 'compaction_end' | 'queue_update' | 'thinking_level_changed' | 'summarization_retry_scheduled' | 'summarization_retry_attempt_start' | 'summarization_retry_finished' | 'auto_compaction_start' | 'auto_compaction_end' | 'auto_retry_start' | 'auto_retry_end';
    [key: string]: any;
} | {
    type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
    toolCallId: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    partialResult?: unknown;
    isError?: boolean;
});
interface WorkerReply {
    records?: WorkerRecord[];
    state?: string;
    response?: {
        id?: string;
        command?: string;
        success?: boolean;
        error?: string;
        code?: string;
        data?: {
            disposition?: 'started' | 'queued' | 'handled';
            discardedInputHashes?: string[];
            [key: string]: any;
        };
    };
    status?: string;
}
type ExecutorStartup = {
    kind: 'codex';
    version: string;
    authMode: 'api-key';
    threadId: string;
} | {
    kind: string;
    version: string;
    protocol: string;
    capabilities: ExecutorCapabilities;
};
export interface SandboxManager {
    agentRpc(agentId: string, input: Record<string, unknown>, options: {
        timeoutMs: number;
        since?: number;
        transportTimeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<WorkerReply>;
    coreFileOperation(agentId: string, action: 'snapshot', input: FileSnapshotOptions): Promise<WorkerFileSnapshot>;
    coreFileOperation(agentId: string, action: 'replace', input: FileReplaceOptions): Promise<WorkerFileReplace>;
    coreFileOperation(agentId: string, action: 'pause' | 'resume', input: {
        requestId: string;
    }): Promise<{
        paused: boolean;
        requestId: string;
    }>;
    coreSessionSnapshot(agentId: string): Promise<SessionFork>;
    collectCoreSession(agentId: string): AsyncIterable<import('../artifact-collection.js').ArtifactRecord>;
    ensureExecution(options: Record<string, unknown>): Promise<{
        sandbox_id: string;
    }>;
    agentVersions(options: {
        executionId: string;
        executor?: string;
        externalExecutor?: boolean;
    }): Promise<{
        piVersion?: string;
        [key: string]: unknown;
    }>;
    startAgent(options: Record<string, unknown>): Promise<{
        backend?: ExecutorStartup;
        isolation?: {
            cpu: number;
            memoryBytes: number;
            managementAuthentication: boolean;
        };
    } | undefined>;
    /** Return true only when confirmed stopped. Return false for no running executor before start dispatch.
     * Throw or return false for an unconfirmed stop after start dispatch, retaining the resource for retry. */
    stopAgent(agentId: string, signal: string, options: {
        preserveWorker: boolean;
    }): Promise<boolean>;
    collectCoreFiles(agentId: string, specification: NonNullable<Profile['collect']>): AsyncIterable<import('../artifact-collection.js').ArtifactRecord>;
    coreResource(agentId: string): {
        resourceKey: string;
        sandboxId?: string;
        creation: 'created' | 'pending' | 'absent';
        executionStopped: boolean;
        expiresAt?: string | null;
    } | undefined;
    /** Resolve after confirmed deletion or absence. Throw while the deletion outcome is uncertain. */
    stopExecution(agentId: string): Promise<unknown>;
    renewExecution?(resourceKey: string, minimumExpiresAtMs: number): Promise<{
        sandboxId: string;
        expiresAt: string;
    }>;
    close?(): Promise<void>;
}
interface BackendOptions {
    runtimeId: string;
    outputDir: string;
    bridge: Awaited<ReturnType<typeof createCoreBridge>>;
    modelAccess: Awaited<ReturnType<typeof createCoreModelAccess>>;
    registerPrivateValues?: (values: readonly unknown[]) => void;
    providers?: readonly OpenSandboxProvider[];
    durability?: {
        ledger: AllocationLedger;
        retainForMs: number;
        renewConcurrency: number;
    };
}
interface AllocationRecord {
    state: string;
    providerId: string;
    resourceKey: string;
    timeoutSeconds?: number;
    sandboxId?: string;
    observation?: string;
    rejection?: boolean;
    expiresAt?: string | null;
}
interface BackendSpawnOptions {
    agentId: string;
    profile: Profile;
    options?: SpawnOptions;
    signal?: AbortSignal;
    onEvent(event: BackendEvent): void;
    onExecutionStart?: () => void;
    beforeCompact?: {
        timeoutMs: number;
        handler(request: Omit<BeforeCompactRequest, 'agentId' | 'profile' | 'signal'>): Promise<BeforeCompactDecision>;
    };
    onTrace?: (record: Readonly<Record<string, unknown>>) => void;
    recordAllocation(record: AllocationRecord): void;
}
import type { CreateRuntimeOptions } from '../types.js';
import type { ExecutorCapabilities, OpenSandboxBackendConfig, Sandbox, SandboxConfig, SandboxProviderConfig } from '../backend-config.js';
import { type ExecutorDriver } from './executor-driver.js';
import { createWorkerEventPoll } from '../worker-event-poll.js';
import { type OpenSandboxProvider } from './opensandbox-provider.js';
export type ResolvedOpenSandboxBackendConfig = Omit<OpenSandboxBackendConfig, 'executor'> & {
    readonly driver: Readonly<ExecutorDriver>;
    readonly filePolicy: ResolvedFilePolicy;
};
export declare function createSandbox(config?: SandboxConfig | SandboxProviderConfig): Sandbox;
export declare function claimOpenSandboxBackend(handle: Sandbox, options: Pick<CreateRuntimeOptions, 'models' | 'executor' | 'connection' | 'filePolicy'>): ResolvedOpenSandboxBackendConfig;
export declare function openOpenSandboxBackend(config: ResolvedOpenSandboxBackendConfig, { runtimeId, outputDir, bridge, modelAccess, registerPrivateValues, durability, providers, }: BackendOptions): Promise<{
    sessionCapabilities(agentId: string): import("../session-types.js").AgentSessionCapabilities | undefined;
    spawn({ agentId, profile, options, signal, onEvent, onExecutionStart, onTrace, recordAllocation, beforeCompact }: BackendSpawnOptions): Promise<{
        providerId: string;
        resourceKey: string;
        sandboxId: string;
        versions: {
            [x: string]: unknown;
            piVersion?: string;
        };
        providerVersion: string | undefined;
        effective: {
            cpu: number;
            memoryBytes: number;
            managementAuthentication: boolean;
        } | undefined;
        backend?: ExecutorStartup | undefined;
    }>;
    recover(record: LedgerAllocation, handlers: Pick<BackendSpawnOptions, 'onEvent' | 'onExecutionStart' | 'onTrace' | 'beforeCompact'>): Promise<{
        available: boolean;
        executionStopped: boolean;
        terminal: boolean;
    }>;
    resume(agentId: string): void;
    snapshotFiles(agentId: string, input: FileSnapshotOptions): Promise<WorkerFileSnapshot>;
    replaceFiles(agentId: string, input: FileReplaceOptions): Promise<WorkerFileReplace>;
    send(agentId: string, input: string, { mode, inputId, steeringMode, executionEpoch, wakeIfIdle, queryOnly }: {
        mode: InputMode;
        inputId: string;
        steeringMode?: SendOptions['steeringMode'];
        executionEpoch: number;
        wakeIfIdle: boolean;
        queryOnly?: boolean;
    }): Promise<BackendInputReceipt>;
    diagnostics(): {
        eventReads: number;
        renewing: number;
    };
    probeWorkerEvent(agentId: string, id: string, timeoutMs: number): Promise<void>;
    sessionCommand(agentId: string, command: string, payload: Record<string, unknown>, query: boolean): Promise<unknown>;
    interrupt(agentId: string, { interruptId, executionEpoch }: {
        interruptId: string;
        executionEpoch: number;
    }): Promise<Omit<InterruptReceipt, 'interruptId'>>;
    stopExecution(agentId: string): Promise<{
        collectable: boolean;
    }>;
    collectSession(agentId: string): AsyncGenerator<import("../artifact-collection.js").ArtifactRecord, void, any>;
    collect(agentId: string, specification: NonNullable<Profile['collect']>): AsyncGenerator<import("../artifact-collection.js").ArtifactRecord, void, any>;
    resource(agentId: string): {
        resourceKey: string;
        sandboxId?: string;
        creation: 'created' | 'pending' | 'absent';
        executionStopped: boolean;
        expiresAt?: string | null;
        providerId: string | undefined;
        retention?: {
            reason: "archive-session" | "collect-artifacts";
            status: "retain-at-risk" | "retained";
            autoRenewing: boolean;
            deadline?: string | undefined;
            owner?: string | undefined;
        } | undefined;
    } | undefined;
    retain(agentId: string, reason: NonNullable<BackendAgent['retaining']>, deadline?: string): void;
    finishRetention(): Promise<void>;
    destroy(agentId: string): Promise<void>;
    detach(): Promise<void>;
    close(): Promise<void>;
}>;
export {};
```

#### dist/src/core/sandbox/executor-driver.d.ts

```ts
import { resolvePiModelCatalog } from '../model/model-catalog.js';
import type { ExecutorCapabilities, ModelConfig } from '../backend-config.js';
import { type BuiltinExecutorSelection, type ExecutorAdapter, type ExecutorSelection } from '../executor-adapter.js';
type Model = ModelConfig;
export interface ExecutorDriver {
    readonly kind: string;
    readonly name: string;
    readonly version: string;
    readonly capabilities: ExecutorCapabilities;
    readonly compatibleVersions: readonly string[];
    readonly adapter?: ExecutorAdapter;
    readonly defaultMaxOutputTokens?: null;
    assertEnvironment?(environment: Readonly<Record<string, string>> | undefined): void;
    modelCatalogResource?(model: Model): ReturnType<typeof resolvePiModelCatalog>;
    credentials(model: Model, baseUrl: string, token: string): {
        environment: Record<string, string>;
        secretEnvironment: Record<string, string>;
    };
    start(options: {
        model: Model;
        baseUrl: string;
        forkSession: boolean;
    }): {
        command: 'pi';
        args: string[];
    } | {
        command: 'codex';
        args: string[];
        codex: {
            model: string;
            baseUrl: string;
            version: string;
        };
    } | {
        command: string;
        args: [];
        externalExecutor: ExecutorAdapter;
    };
}
export declare function createPiExecutor({ version }?: {
    version?: string;
}): BuiltinExecutorSelection;
export declare function createCodexExecutor({ version }?: {
    version?: string;
}): BuiltinExecutorSelection;
export declare function createExecutorAdapter(input: ExecutorAdapter): ExecutorAdapter;
export declare function selectExecutorDriver(executor?: unknown): Readonly<ExecutorDriver>;
export declare function getExecutorCapabilities(executor: ExecutorSelection): ExecutorCapabilities;
export {};
```

#### dist/src/core/backend-config.d.ts

```ts
declare const sandboxBrand: unique symbol;
export interface Sandbox {
    readonly [sandboxBrand]: true;
}
import type { OpenSandboxProvider, SandboxProvider } from './sandbox/opensandbox-provider.js';
import type { ModelCapabilities, ModelProtocol, ModelTransport } from './model/model-transport.js';
import type { ExecutorSelection } from './executor-adapter.js';
export interface SandboxProviderConfig {
    provider: SandboxProvider;
    timeoutSeconds?: number;
}
export interface SandboxConfig {
    kind?: 'opensandbox';
    endpoint?: string;
    /** Migration alias for endpoint. */
    lifecycleBaseUrl?: string;
    apiKey?: string;
    execdToken?: string;
    endpointHost?: string;
    useServerProxy?: boolean;
    /** Assertion by the deployment administrator. Smoke verifies the actual policy. */
    egressMode?: 'dns+nft';
    resourceLimits?: {
        cpu: string;
        memory: string;
    };
    resourceRequests?: {
        cpu: string;
        memory: string;
    };
    commandTimeoutMs?: number;
    timeoutSeconds?: number;
    isolation?: {
        network?: 'local-docker';
        disk: {
            bytes: number;
            inodes: number;
        };
    } | {
        network?: 'api';
        disk?: {
            bytes: number;
            inodes?: never;
        };
    };
}
export type ExecutorKind = 'pi' | 'codex';
export type SteeringMode = 'all' | 'one-at-a-time';
export interface ExecutorCapabilities {
    readonly session?: import('./session-types.js').AgentSessionCapabilities;
    readonly activeSteer: boolean;
    readonly followUp: boolean;
    readonly conditionalInput: boolean;
    readonly queuedInputCancellation: boolean;
    readonly contextFork: boolean;
    readonly steeringModes: readonly SteeringMode[];
}
export interface ModelConfig {
    provider: string;
    model: string;
    protocol?: ModelProtocol | ModelTransport;
    capabilities?: ModelCapabilities;
    upstream: {
        url: string;
        headers: Readonly<Record<string, string>>;
    };
}
export interface RuntimeConnectionOptions {
    publicUrl?: string;
    bindHost?: string;
    bindPort?: number;
    advertiseHost?: string;
    bridge?: {
        host?: string;
        publicUrl?: string;
    };
    modelGateway?: {
        host?: string;
        advertiseHost?: string;
        publicUrl?: string;
        requestTimeoutMs?: number;
        maxOutputTokens?: number | null;
        /** Maximum new upstream attempts per Runtime and model alias, including unknown outcomes. */
        maxRequests?: number;
    };
}
export interface OpenSandboxBackendConfig {
    /** Defaults to Pi. Runtime resolves this selection at assembly. */
    executor?: ExecutorSelection;
    sandbox: {
        lifecycleBaseUrl?: string;
        apiKey?: string;
        execdToken?: string;
        endpointHost?: string;
        useServerProxy?: boolean;
        egressMode?: 'dns+nft';
        publicUrl?: string;
        advertiseHost?: string;
        resourceLimits?: {
            cpu: string;
            memory: string;
        };
        resourceRequests?: {
            cpu: string;
            memory: string;
        };
        commandTimeoutMs?: number;
        /** Sandbox creation lifetime in seconds; safe integer >= 60, default 3600. Provider limits also apply. */
        timeoutSeconds?: number;
    };
    callback?: {
        host: string;
        port: number;
        publicUrl: string;
    };
    bridge: {
        host: string;
        publicUrl: string;
    };
    modelGateway: {
        host: string;
        advertiseHost?: string;
        publicUrl?: string;
        requestTimeoutMs?: number;
        /** Cap new upstream attempts per Runtime and model alias, including unknown outcomes. */
        maxRequests?: number;
        /** null preserves executor output parameters without a host token clamp. */
        maxOutputTokens?: number | null;
    };
    models: Readonly<Record<string, ModelConfig>>;
    provider?: SandboxProvider & OpenSandboxProvider;
    isolation: {
        network: 'api' | 'provider';
        disk?: never;
    };
}
export {};
```

#### dist/src/core/sandbox/opensandbox-provider.d.ts

```ts
import type { OpenSandboxBackendConfig } from '../backend-config.js';
import type { SandboxManager } from './opensandbox-backend.js';
export interface SandboxPreparation {
    sandboxId: string;
    agent: {
        agent_id: string;
        runtime_id: string;
        resource_key: string;
    };
    bridgeUrl: string;
    modelUrl: string;
    additionalEndpoints: readonly string[];
    workspace?: {
        id: string;
        mode: 'read-only' | 'read-write';
    };
    assertOpen(): void;
}
export interface SandboxProvider {
    readonly id: string;
    readonly version: string;
    readonly capabilities: Readonly<{
        sharedWorkspace?: boolean;
        networkAllowlist?: boolean;
    }>;
    preflight(): Promise<void>;
    openManager(image: string): SandboxManager;
    prepareSandbox(input: SandboxPreparation): Promise<void>;
    createSharedWorkspace?(runtimeId: string, workspaceId: string): Promise<void>;
    deleteSharedWorkspace?(runtimeId: string, workspaceId: string): Promise<void>;
}
export interface OpenSandboxProvider {
    readonly id: string;
    readonly version?: string;
    readonly capabilities?: SandboxProvider['capabilities'];
    preflight?(): Promise<void>;
    beforeAllocation?(): Promise<void>;
    openManager(image: string): SandboxManager;
    prepareSandbox(input: SandboxPreparation): Promise<void>;
    createSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
    deleteSharedWorkspace(runtimeId: string, workspaceId: string): Promise<void>;
}
export declare function createApiOpenSandboxProvider({ sandbox }: OpenSandboxBackendConfig): OpenSandboxProvider;
export declare function adaptSandboxProvider(provider: SandboxProvider): SandboxProvider & OpenSandboxProvider;
```

#### dist/src/core/sandbox/sandbox-connection.d.ts

```ts
export declare const defaultLifecycleUrl = "http://127.0.0.1:8080/v1";
export declare function loopbackLifecycle(url: string): URL | undefined;
export declare function localApiKeyPath(url: URL): string;
interface ConnectionInput {
    endpoint?: string;
    lifecycleBaseUrl?: string;
    apiKey?: string;
    endpointHost?: string;
    advertiseHost?: string;
    publicUrl?: string;
    image?: string;
    useServerProxy?: boolean;
    egressMode?: 'dns+nft';
}
export declare function normalizeRuntimePublicUrl(value: string): string;
export declare function resolveSandboxConnectionWithSources(input?: ConnectionInput, scope?: string, { useSaved }?: {
    useSaved?: boolean | undefined;
}): {
    lifecycleBaseUrl: string;
    apiKey: string | undefined;
    advertiseHost: string | undefined;
    publicUrl: string | undefined;
    image: string | undefined;
    useServerProxy: boolean | undefined;
    egressMode: "dns+nft" | undefined;
    endpointHost: undefined;
    endpointSource: string;
    sources: {
        lifecycleBaseUrl: string;
        advertiseHost: string | undefined;
        image: string | undefined;
    };
};
export declare function resolveSandboxConnection(...settings: Parameters<typeof resolveSandboxConnectionWithSources>): {
    lifecycleBaseUrl: string;
    apiKey: string | undefined;
    advertiseHost: string | undefined;
    publicUrl: string | undefined;
    image: string | undefined;
    useServerProxy: boolean | undefined;
    egressMode: "dns+nft" | undefined;
    endpointHost: undefined;
    endpointSource: string;
};
export declare function saveSandboxConnection(input: ConnectionInput & {
    lifecycleBaseUrl: string;
}): Promise<void>;
export declare function loadMurmConfig(filename: string): Promise<unknown>;
export {};
```

<!-- END GENERATED REFERENCE -->
