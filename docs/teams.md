# Teams channel connector

`@introspection-ai/recipe-connector-teams` is the Microsoft Teams adapter for
the [channel tools](channels.md). It exists as much to prove the abstraction as
to serve Teams: it registers the same tool names Slack does, with a materially
smaller capability set, and a Recipe written against the shared subset runs on
both without a prompt change.

It speaks the **Bot Framework Connector** — the credential every Teams bot has —
and nothing else.

## Declare it

```json
{
  "dependencies": {
    "@introspection-ai/recipe-connector-teams": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "teams",
        "package": "@introspection-ai/recipe-connector-teams",
        "tools": { "include": ["info", "reply", "edit", "retract"] }
      }
    ]
  }
}
```

## What Teams registers

| Tool | Bot Connector operation |
| --- | --- |
| `channel_info` | the bound conversation, from the task origin |
| `channel_reply` | `POST /v3/conversations/{id}/activities[/{replyToId}]` |
| `channel_edit` | `PUT /v3/conversations/{id}/activities/{id}` |
| `channel_retract` | `DELETE /v3/conversations/{id}/activities/{id}` |

Replies are posted with `textFormat: "markdown"`, which Teams renders natively.

## What Teams does not register, and why

`channel_history`, `channel_react`, `channel_fetch_file` and the document tools
are **absent**, not failing:

- **History** requires Microsoft Graph with resource-specific consent granted by
  the tenant administrator. The Bot Connector cannot read a conversation back.
- **Reactions** likewise go through Graph.
- **File download**: inbound Teams files are Graph `hostedContents` or SharePoint
  links. Unlike Slack there is no single bot-token download path.
- **Permalinks** come from the Graph `webUrl`, behind the same consent — so
  reply results carry no permalink.

The agent therefore works from the turn it was given. Author display names are
the one thing Teams gives away for free: they ride on the inbound activity, so
`resolveAuthors` is true and costs no lookup.

A tenant that has granted resource-specific consent can flip these capabilities
in a build of the adapter; the tool schemas are already defined centrally and
need no new code to appear.

## Service URL

Teams supplies a per-tenant `serviceUrl` on each inbound activity, and replies
go to that host rather than a fixed endpoint. This adapter supports the Teams
Bot Connector at `smba.trafficmanager.net`. It requires HTTPS and an exact host
match. It does not accept other Azure Traffic Manager profiles because Azure
customers can control those hosts.

## Local runs

```bash
export TEAMS_BOT_TOKEN='...'
export TEAMS_SERVICE_URL='https://smba.trafficmanager.net/amer/'
export TEAMS_CONVERSATION_ID='19:...@thread.v2'
export TEAMS_ACTIVITY_ID='...' # optional, threads the reply
```

In cloud, the task origin (`INTROSPECTION_TASK_CHANNEL_ID`,
`INTROSPECTION_TASK_THREAD_ID`) supplies these and the session locator is
exchanged for the bot credential at the egress boundary, exactly as for Slack.

## Status

The adapter and its tests ship here. The platform side — connector catalog
entry, AAD client-credentials auth mode, the
`POST /v1/webhooks/teams/{connector_id}` ingress verified against the Bot
Framework JWKS, and the Teams member key — is a separate change; until it
lands, Teams runs locally and through a custom host.
