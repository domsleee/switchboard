//! What a Claude chat has cost at Anthropic API rates, from the usage Claude Code records on
//! each assistant message. Subscription plans are not billed per token; the sidebar shows this
//! only for computers the user marks as using API credits.
use serde_json::{json, Value};
use std::collections::HashMap;

/// Dollars per million tokens. Cache writes cost 1.25× input for five minutes and 2× for an hour.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
}

/// Anthropic first-party rates (cached from the pricing page, 2026-10-06).
fn price(model: &str) -> Option<Price> {
    let p = |input, output, cache_read| {
        Some(Price {
            input,
            output,
            cache_read,
        })
    };
    // Claude Code records the alias, sometimes with a date or a context suffix such as `[1m]`.
    let model = model.trim_start_matches("anthropic.");
    // A different version, such as `claude-opus-4-9` for `claude-opus-4`, is unknown.
    let family = |name: &str| {
        model.strip_prefix(name).is_some_and(|rest| {
            let date = rest.strip_prefix(['-', '@']).unwrap_or(rest);
            let digits = date.bytes().take_while(u8::is_ascii_digit).count();
            rest.is_empty() || rest.starts_with('[') || digits == 8 && date.len() != rest.len()
        })
    };
    match () {
        _ if family("claude-fable-5-1") || family("claude-mythos-5-1") => p(10.0, 50.0, 0.25),
        _ if family("claude-fable-5") || family("claude-mythos-5") => p(10.0, 50.0, 1.0),
        _ if family("claude-opus-5-5") => p(4.0, 20.0, 0.2),
        _ if family("claude-opus-5")
            || family("claude-opus-4-8")
            || family("claude-opus-4-7")
            || family("claude-opus-4-6")
            || family("claude-opus-4-5") =>
        {
            p(5.0, 25.0, 0.5)
        },
        _ if family("claude-opus-4-1") || family("claude-opus-4") => p(15.0, 75.0, 1.5),
        _ if family("claude-sonnet-5-5") || family("claude-sonnet-5") => p(2.0, 10.0, 0.2),
        _ if family("claude-sonnet-4-6")
            || family("claude-sonnet-4-5")
            || family("claude-sonnet-4") =>
        {
            p(3.0, 15.0, 0.3)
        },
        _ if family("claude-haiku-5-5") => p(0.1, 0.5, 0.01),
        _ if family("claude-haiku-4-5") => p(1.0, 5.0, 0.1),
        _ => None,
    }
}

#[derive(Clone, Default, PartialEq, Debug)]
struct Turn {
    model: String,
    input: u64,
    cache_5m: u64,
    cache_1h: u64,
    cache_read: u64,
    output: u64,
    web_searches: u64,
    fast: bool,
}

impl Turn {
    fn cost(&self) -> Option<f64> {
        let mut price = price(&self.model)?;
        let prompt = self.input + self.cache_5m + self.cache_1h + self.cache_read;
        // Haiku 5.5 charges five times as much for a prompt over 100K tokens.
        if self.model.starts_with("claude-haiku-5-5") && prompt > 100_000 {
            price = Price {
                input: 0.5,
                output: 2.5,
                cache_read: 0.05,
            };
        }
        // Fast mode doubles the Opus 5 and 5.5 rates.
        if self.fast && self.model.starts_with("claude-opus-5") {
            price.input *= 2.0;
            price.output *= 2.0;
            price.cache_read *= 2.0;
        }
        let tokens = self.input as f64 * price.input
            + self.cache_5m as f64 * price.input * 1.25
            + self.cache_1h as f64 * price.input * 2.0
            + self.cache_read as f64 * price.cache_read
            + self.output as f64 * price.output;
        Some(tokens / 1e6 + self.web_searches as f64 * 0.01)
    }
}

/// Usage per API response. Claude Code writes one record per content block, each repeating the
/// response's usage, so records with the same message ID count once and the latest wins.
#[derive(Clone, Default)]
pub(super) struct Usage {
    turns: HashMap<String, Turn>,
}

impl Usage {
    pub(super) fn clear(&mut self) {
        self.turns.clear();
    }

    pub(super) fn record(&mut self, v: &Value) {
        let message = &v["message"];
        let usage = &message["usage"];
        let (Some(id), Some(model)) = (message["id"].as_str(), message["model"].as_str()) else {
            return;
        };
        if v["type"] != "assistant" || !usage.is_object() || model == "<synthetic>" {
            return;
        }
        let n = |value: &Value| value.as_u64().unwrap_or(0);
        let creation = &usage["cache_creation"];
        let written = n(&usage["cache_creation_input_tokens"]);
        // Older records give only the total, which Claude Code wrote with the five-minute TTL.
        let (cache_5m, cache_1h) = if creation.is_object() {
            let hour = n(&creation["ephemeral_1h_input_tokens"]);
            (written.saturating_sub(hour), hour)
        } else {
            (written, 0)
        };
        let turn = Turn {
            model: model.chars().take(128).collect(),
            input: n(&usage["input_tokens"]),
            cache_5m,
            cache_1h,
            cache_read: n(&usage["cache_read_input_tokens"]),
            output: n(&usage["output_tokens"]),
            web_searches: n(&usage["server_tool_use"]["web_search_requests"]),
            fast: usage["speed"] == "fast",
        };
        if self.turns.len() < 1_000_000 || self.turns.contains_key(id) {
            self.turns.insert(id.chars().take(128).collect(), turn);
        }
    }

    /// Totals for the chat, or null before its first response. `unpriced_tokens` counts tokens
    /// from models without a known price, which `cost_usd` leaves out.
    pub(super) fn summary(&self) -> Value {
        if self.turns.is_empty() {
            return Value::Null;
        }
        let (mut cost, mut unpriced) = (0.0, 0);
        let (mut input, mut cache_write, mut cache_read, mut output) = (0, 0, 0, 0);
        for turn in self.turns.values() {
            input += turn.input;
            cache_write += turn.cache_5m + turn.cache_1h;
            cache_read += turn.cache_read;
            output += turn.output;
            match turn.cost() {
                Some(dollars) => cost += dollars,
                None => {
                    unpriced +=
                        turn.input + turn.cache_5m + turn.cache_1h + turn.cache_read + turn.output
                },
            }
        }
        json!({
            "cost_usd": (cost * 10_000.0).round() / 10_000.0,
            "input_tokens": input,
            "cache_write_tokens": cache_write,
            "cache_read_tokens": cache_read,
            "output_tokens": output,
            "responses": self.turns.len(),
            "unpriced_tokens": unpriced,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(id: &str, model: &str, usage: Value) -> Value {
        json!({"type":"assistant","message":{"id":id,"model":model,"usage":usage}})
    }

    #[test]
    fn switchboard_chat_cost_counts_each_response_once_at_its_model_rate() {
        // Shape captured from Claude Code 2.1.319: three content blocks, one response.
        let usage = json!({"input_tokens":2,"cache_creation_input_tokens":15053,
            "cache_read_input_tokens":32598,"output_tokens":330,
            "server_tool_use":{"web_search_requests":0},"speed":"standard",
            "cache_creation":{"ephemeral_1h_input_tokens":15053,"ephemeral_5m_input_tokens":0}});
        let mut tally = Usage::default();
        for _ in 0..3 {
            tally.record(&assistant("msg_a", "claude-opus-5-5", usage.clone()));
        }
        let summary = tally.summary();
        assert_eq!(summary["responses"], 1);
        assert_eq!(summary["cache_write_tokens"], 15053);
        // 2×$4 + 15053×$8 (1h write) + 32598×$0.20 + 330×$20, per million tokens.
        let expected = (2.0 * 4.0 + 15053.0 * 8.0 + 32598.0 * 0.2 + 330.0 * 20.0) / 1e6;
        assert!((summary["cost_usd"].as_f64().unwrap() - expected).abs() < 0.0001);
    }

    #[test]
    fn switchboard_chat_cost_keeps_the_latest_usage_and_reports_unknown_models() {
        let mut tally = Usage::default();
        tally.record(&assistant(
            "msg_a",
            "claude-sonnet-4-6",
            json!({"input_tokens":1000,"output_tokens":10}),
        ));
        tally.record(&assistant(
            "msg_a",
            "claude-sonnet-4-6",
            json!({"input_tokens":1000,"output_tokens":1000}),
        ));
        tally.record(&assistant(
            "msg_b",
            "claude-future-9",
            json!({"input_tokens":50,"output_tokens":50}),
        ));
        tally.record(&assistant(
            "msg_c",
            "<synthetic>",
            json!({"input_tokens":9,"output_tokens":9}),
        ));
        tally.record(&json!({"type":"user","message":{"id":"msg_d","model":"claude-sonnet-4-6","usage":{"input_tokens":5}}}));
        let summary = tally.summary();
        assert_eq!(summary["responses"], 2);
        assert_eq!(summary["output_tokens"], 1050);
        assert_eq!(summary["unpriced_tokens"], 100);
        assert_eq!(summary["cost_usd"], 0.018);
    }

    #[test]
    fn switchboard_chat_cost_prices_aliases_tiers_and_fast_mode() {
        assert_eq!(price("claude-opus-5"), price("claude-opus-4-8"));
        assert_ne!(price("claude-opus-5"), price("claude-opus-5-5"));
        assert_eq!(price("claude-opus-5-5[1m]"), price("claude-opus-5-5"));
        assert_eq!(
            price("claude-haiku-4-5-20251001"),
            price("claude-haiku-4-5")
        );
        assert_eq!(price("claude-opus-4-1-20250805").unwrap().input, 15.0);
        assert_eq!(price("claude-opus-4-20250514").unwrap().input, 15.0);
        assert_eq!(price("claude-opus-55"), None);
        assert_eq!(price("claude-opus-4-9"), None);
        assert_eq!(price("claude-sonnet-5-7"), None);
        let turn = |model: &str, input, fast| Turn {
            model: model.into(),
            input,
            fast,
            ..Turn::default()
        };
        assert_eq!(turn("claude-opus-5-5", 1_000_000, true).cost(), Some(8.0));
        assert_eq!(turn("claude-haiku-5-5", 100_000, false).cost(), Some(0.01));
        assert_eq!(turn("claude-haiku-5-5", 200_000, false).cost(), Some(0.1));
        assert_eq!(Usage::default().summary(), Value::Null);
    }
}
