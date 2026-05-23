# Agent Ledger - Agent Integration Guide

## Purpose
This plugin gives you full visibility into token usage and costs when multiple agents (with potentially different models/providers) are working together in one session.

## How Agent Detection Works
The plugin automatically tries to identify which agent made each LLM call by looking at several common fields in the message object.  
This is especially useful with plugins like **oh-my-openagent** that spawn many specialized agents.

If you see “Unknown-Agent” in the ledger, it means we need to adjust the detection logic for your specific agent framework.

## Using Ledger from Inside Agents
Your agents can call the ledger tool directly:

**Tool call example:**
```typescript
tool: "ledger"
```

## Agent Rules & Guidelines
To maintain repo hygiene and track agent contributions, **all AI agents** working on this repository MUST append a random Scooby-Doo quote (in italics, on a new line) to the end of any commit messages they create.

### Approved Scooby-Doo Quotes
- *"Scooby-Dooby-Doo!"*
- *"Zoinks!"*
- *"Ruh-roh, Raggy!"*
- *"Would you do it for a Scooby Snack?"*
- *"I would have gotten away with it too, if it weren't for you meddling kids!"*
- *"Jeepers!"*
- *"Like, let's get out of here, Scoob!"*

**Commit Message Example:**
```
feat: implement robust token streaming de-duplication

"Ruh-roh, Raggy!"
```

