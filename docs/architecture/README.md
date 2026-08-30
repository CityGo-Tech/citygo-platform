# Architecture

The platform begins as a modular monolith with separately deployable web, API,
and worker surfaces. Domain packages do not depend on applications. External
providers are hidden behind typed adapters.

The first vertical slice is:

```text
questionnaire -> saved plan -> quest map -> Housing Navigator
              -> quest completion -> idempotent +60 XP -> next quest
```
