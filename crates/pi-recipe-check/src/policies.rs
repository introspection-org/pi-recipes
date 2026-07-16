//! Validation for recipe-resident Cedar policy rails.
//!
//! Recipes may ship deterministic authorization policies as `policies/*.cedar`
//! files with a `policies/schema.cedarschema` contract describing the entities,
//! actions, and request context the evaluating platform supplies:
//!
//! ```text
//! policies/
//! ├── schema.cedarschema   # the contract policies are validated against
//! ├── booking.cedar
//! └── payments.cedar
//! ```
//!
//! This module embeds the official Cedar engine (the `cedar-policy` crate), so
//! the validator applies the exact parser and validator the policies are
//! evaluated with — a policy that parses here parses in production, and a
//! policy referencing attributes the schema never supplies fails the *check*,
//! not the production request. Like [`crate::resources`], the entry point is
//! pure: [`validate_policies`] takes already-read file contents and returns
//! diagnostics, so every host applies the same rules.

use cedar_policy::{PolicySet, Schema, Validator, ValidationMode};

use crate::{Diagnostic, Severity};

pub const SCHEMA_PATH: &str = "policies/schema.cedarschema";

/// Validate a recipe's Cedar policy files against its schema. `files` holds
/// `(path, content)` pairs for every `policies/**/*.cedar` file; `schema` is
/// the content of `policies/schema.cedarschema` when present. Returns no
/// diagnostics when `files` is empty (a recipe without policies is valid).
pub fn validate_policies(
    schema: Option<&str>,
    files: &[(String, Option<String>)],
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    if files.is_empty() {
        return diagnostics;
    }

    let schema = match schema {
        None => {
            push(
                &mut diagnostics,
                Severity::Error,
                "policies.schema_missing",
                SCHEMA_PATH,
                "Recipe declares policies/*.cedar but has no policies/schema.cedarschema",
                Some("add the schema describing entities, actions, and the request context"),
            );
            None
        }
        Some(source) => match Schema::from_cedarschema_str(source) {
            Ok((schema, warnings)) => {
                for warning in warnings {
                    push(
                        &mut diagnostics,
                        Severity::Warning,
                        "policies.schema_warning",
                        SCHEMA_PATH,
                        warning.to_string(),
                        None,
                    );
                }
                Some(schema)
            }
            Err(err) => {
                push(
                    &mut diagnostics,
                    Severity::Error,
                    "policies.schema_invalid",
                    SCHEMA_PATH,
                    format!("policies/schema.cedarschema is not a valid Cedar schema: {err}"),
                    Some("fix the schema; the platform validates policies against it"),
                );
                None
            }
        },
    };
    let validator = schema.map(Validator::new);

    for (path, content) in files {
        let Some(content) = content else {
            push(
                &mut diagnostics,
                Severity::Error,
                "policies.unreadable",
                path,
                "Policy file content was not provided",
                Some("supply the .cedar file content to the validator"),
            );
            continue;
        };
        let policy_set = match content.parse::<PolicySet>() {
            Ok(policy_set) => policy_set,
            Err(err) => {
                push(
                    &mut diagnostics,
                    Severity::Error,
                    "policies.policy_malformed",
                    path,
                    format!("Policy file is not valid Cedar: {err}"),
                    Some("fix the Cedar syntax"),
                );
                continue;
            }
        };
        let Some(validator) = &validator else {
            continue;
        };
        let result = validator.validate(&policy_set, ValidationMode::default());
        for error in result.validation_errors() {
            push(
                &mut diagnostics,
                Severity::Error,
                "policies.policy_invalid",
                path,
                error.to_string(),
                Some("the policy references entities or attributes the schema does not supply"),
            );
        }
        for warning in result.validation_warnings() {
            push(
                &mut diagnostics,
                Severity::Warning,
                "policies.policy_warning",
                path,
                warning.to_string(),
                None,
            );
        }
    }

    diagnostics
}

fn push(
    diagnostics: &mut Vec<Diagnostic>,
    severity: Severity,
    code: &str,
    path: &str,
    message: impl Into<String>,
    help: Option<&str>,
) {
    diagnostics.push(Diagnostic {
        severity,
        code: code.to_owned(),
        path: path.to_owned(),
        span: None,
        message: message.into(),
        help: help.map(str::to_owned),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA: &str = r#"
entity Agent;
entity Connector;

action "connector:use" appliesTo {
  principal: [Agent],
  resource: [Connector],
  context: {
    mission: {
      granted: Bool,
      subject: String,
      amount_cents?: Long,
      currency?: String,
      single_use?: Bool,
    },
    recipe: {
      slug: String,
      commit: String,
    },
  }
};
"#;

    const PAYMENTS: &str = r#"
permit (
  principal,
  action == Action::"connector:use",
  resource == Connector::"stripe"
)
when {
  context.mission.granted &&
  context.mission.subject == "person" &&
  context.mission has amount_cents && context.mission.amount_cents <= 50000 &&
  context.mission has single_use && context.mission.single_use
};
"#;

    fn codes(schema: Option<&str>, files: &[(String, Option<String>)]) -> Vec<String> {
        validate_policies(schema, files)
            .into_iter()
            .map(|diagnostic| diagnostic.code)
            .collect()
    }

    fn file(path: &str, content: &str) -> (String, Option<String>) {
        (path.to_owned(), Some(content.to_owned()))
    }

    #[test]
    fn accepts_the_documented_example() {
        let files = [file("policies/payments.cedar", PAYMENTS)];
        assert!(
            codes(Some(SCHEMA), &files).is_empty(),
            "{:?}",
            validate_policies(Some(SCHEMA), &files)
        );
    }

    #[test]
    fn no_policies_is_valid() {
        assert!(codes(Some(SCHEMA), &[]).is_empty());
        assert!(codes(None, &[]).is_empty());
    }

    #[test]
    fn requires_a_schema_when_policies_exist() {
        let files = [file("policies/payments.cedar", PAYMENTS)];
        assert_eq!(codes(None, &files), ["policies.schema_missing"]);
    }

    #[test]
    fn rejects_a_malformed_schema() {
        let files = [file("policies/payments.cedar", PAYMENTS)];
        assert_eq!(
            codes(Some("entity ;;;"), &files),
            ["policies.schema_invalid"]
        );
    }

    #[test]
    fn rejects_malformed_cedar() {
        let files = [file("policies/broken.cedar", "permit (principal")];
        assert_eq!(
            codes(Some(SCHEMA), &files),
            ["policies.policy_malformed"]
        );
    }

    #[test]
    fn rejects_attributes_the_schema_never_supplies() {
        let policy = r#"
permit (principal, action == Action::"connector:use", resource == Connector::"stripe")
when { context.mission.amount_dollars <= 500 };
"#;
        let files = [file("policies/payments.cedar", policy)];
        let codes = codes(Some(SCHEMA), &files);
        assert!(
            codes.contains(&"policies.policy_invalid".to_owned()),
            "{codes:?}"
        );
    }

    #[test]
    fn rejects_unknown_entities_and_actions() {
        let policy = r#"
permit (principal, action == Action::"connector:launch", resource == Rocket::"ship");
"#;
        let files = [file("policies/rocket.cedar", policy)];
        let codes = codes(Some(SCHEMA), &files);
        assert!(!codes.is_empty(), "unknown action/entity must not validate");
    }

    #[test]
    fn unreadable_content_is_an_error() {
        let files = [("policies/payments.cedar".to_owned(), None)];
        assert_eq!(codes(Some(SCHEMA), &files), ["policies.unreadable"]);
    }
}
