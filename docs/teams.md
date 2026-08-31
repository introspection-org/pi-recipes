# Teams channel connector

`@introspection-ai/recipe-channel-teams` is the Microsoft Teams adapter for
the [channel tools](channels.md). It uses the Bot Framework Connector credential
that every Teams bot has. A Recipe that only selects `channel_reply` can use
Slack or Teams without changing its prompt.

## Declare it

```json
{
  "dependencies": {
    "@introspection-ai/recipe-channel-teams": "^0.1.0"
  },
  "pi": {
    "connectors": [
      {
        "provider": "teams"
      }
    ]
  }
}
```

## What Teams registers

| Tool | Bot Connector operation |
| --- | --- |
| `channel_reply` | `POST /v3/conversations/{id}/activities[/{replyToId}]` |

Replies are posted with `textFormat: "markdown"`, which Teams renders natively.

## What Teams does not register, and why

`channel_read`, `channel_react`, `channel_fetch_file` and the document tools
are **absent**, not failing:

- **History** requires Microsoft Graph with resource-specific consent granted by
  the tenant administrator. The Bot Connector cannot read a conversation back.
- **Reactions** likewise go through Graph.
- **File download**: inbound Teams files are Graph `hostedContents` or SharePoint
  links. Unlike Slack there is no single bot-token download path.
- **Permalinks** come from the Graph `webUrl`, which needs the same consent.
  Reply results therefore carry no permalink.

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

The adapter and its tests ship here. The platform work includes the connector
catalog entry, AAD client credentials auth mode, the
`POST /v1/webhooks/teams/{connector_id}` ingress verified against the Bot
Framework JWKS, and the Teams member key. That work is a separate change. Until
it lands, Teams runs locally and through a custom host.
