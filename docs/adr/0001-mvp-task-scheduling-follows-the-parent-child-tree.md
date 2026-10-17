# MVP task scheduling follows the parent-child tree

Status: accepted. In the MVP, a Task may wait for and require only its direct child Tasks; nested task trees propagate completion one parent-child edge at a time. Cross-tree support, dependency, and weaving relationships remain descriptive metadata or Material references until a later version defines their lifecycle, cycle handling, and recovery semantics. This keeps the first scheduler a strict tree while preserving the relationships as future domain information.

## Considered options

- Allow arbitrary Tasks to block or wake one another through cross-tree dependencies.
- Restrict scheduling conditions to direct child Tasks and let each child recursively manage its own children.

## Consequences

`required_children` and `child_task_terminal` have a precise MVP meaning, and `BLOCKED` does not imply an undeclared graph scheduler. A parent that needs a grandchild's result waits for the intermediate child to satisfy its own contract. Cross-tree relationships cannot independently trigger scheduling in this version.
