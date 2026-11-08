//! Codex API-equivalent cost from rollout usage, following T3 Code's transcript approach.
//! Rates: https://developers.openai.com/api/docs/pricing and /models/<model>, 2026-11-08.
use serde_json::{json, Value};

#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Tokens {
    input: u64,
    cached: u64,
    written: u64,
    output: u64,
}
impl Tokens {
    fn read(v: &Value) -> Option<Self> {
        let tokens = Self {
            input: v["input_tokens"].as_u64()?,
            cached: v["cached_input_tokens"].as_u64().unwrap_or(0),
            written: v["cache_write_input_tokens"].as_u64().unwrap_or(0),
            output: v["output_tokens"].as_u64()?,
        };
        (tokens.cached.checked_add(tokens.written)? <= tokens.input
            && v["reasoning_output_tokens"].as_u64().unwrap_or(0) <= tokens.output)
            .then_some(tokens)
    }
    fn difference(self, previous: Self) -> Option<Self> {
        Some(Self {
            input: self.input.checked_sub(previous.input)?,
            cached: self.cached.checked_sub(previous.cached)?,
            written: self.written.checked_sub(previous.written)?,
            output: self.output.checked_sub(previous.output)?,
        })
    }
    fn add(&mut self, other: Self) {
        self.input += other.input;
        self.cached += other.cached;
        self.written += other.written;
        self.output += other.output;
    }
}

// Exact aliases and dated snapshots only: a new model must not inherit an old model's price.
fn model_alias(model: &str) -> &str {
    let model = model.strip_prefix("openai/").unwrap_or(model);
    if model.len() > 11 {
        model
            .get(..model.len() - 11)
            .filter(|_| {
                let date = &model.as_bytes()[model.len() - 11..];
                date.iter().enumerate().all(|(i, b)| {
                    if matches!(i, 0 | 5 | 8) {
                        *b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
            })
            .unwrap_or(model)
    } else {
        model
    }
}

fn rates(model: &str) -> Option<(f64, f64, f64)> {
    Some(match model {
        "gpt-6.1-sol" => (2.0, 10.0, 0.1),
        "gpt-6.1-terra" => (1.0, 5.0, 0.05),
        "gpt-6-sol" => (2.0, 10.0, 0.2),
        "gpt-6-astra" => (10.0, 50.0, 1.0),
        "gpt-6-luna" => (0.1, 0.5, 0.01),
        "gpt-5.6-sol" => (4.0, 20.0, 0.4),
        "gpt-5.6-terra" => (2.0, 12.0, 0.2),
        "gpt-5.6-luna" => (0.2, 1.2, 0.02),
        "gpt-5.5" => (5.0, 30.0, 0.5),
        "gpt-5.4" => (2.5, 15.0, 0.25),
        "gpt-5.3-codex" | "gpt-5.2-codex" => (1.75, 14.0, 0.175),
        "gpt-5.1-codex" | "gpt-5-codex" => (1.25, 10.0, 0.125),
        _ => return None,
    })
}

#[derive(Clone, Default)]
pub(super) struct Usage {
    model: String,
    tier: String,
    previous: Option<Tokens>,
    last_event: Option<(Value, Tokens)>,
    pending: Vec<(String, String, Tokens)>,
    totals: Tokens,
    cost: f64,
    unpriced: u64,
    responses: u64,
}
impl Usage {
    pub(super) fn record(&mut self, v: &Value) {
        let p = &v["payload"];
        if v["type"] == "turn_context" {
            if let Some(model) = p["model"].as_str() {
                self.model = model.chars().take(128).collect();
            }
            return;
        }
        if v["type"] == "event_msg" && p["type"] == "thread_settings_applied" {
            self.tier = p["thread_settings"]["service_tier"]
                .as_str()
                .unwrap_or("default")
                .chars()
                .take(32)
                .collect();
            return;
        }
        if v["type"] == "token_usage_record" {
            if let Some(tokens) = Tokens::read(&p["usage"]) {
                if self.pending.len() < 1024 {
                    self.pending
                        .push((self.model.clone(), self.tier.clone(), tokens));
                }
            }
            return;
        }
        if v["type"] != "event_msg" || p["type"] != "token_count" {
            return;
        }
        let info = &p["info"];
        let Some(last) = Tokens::read(&info["last_token_usage"]) else {
            return;
        };
        let cumulative = Tokens::read(&info["total_token_usage"]);
        let previous = self.previous;
        if let Some(total) = cumulative {
            self.previous = Some(total);
        }
        // Context-size markers and repeated rate-limit snapshots are not new requests.
        if last.input + last.output == 0 || cumulative.is_some() && cumulative == previous {
            return;
        }
        let event = (v["timestamp"].clone(), cumulative.unwrap_or(last));
        if self.last_event.as_ref() == Some(&event)
            || cumulative.is_none()
                && self
                    .last_event
                    .as_ref()
                    .is_some_and(|(_, tokens)| *tokens == last)
        {
            return;
        }
        self.last_event = Some(event);
        let pending = std::mem::take(&mut self.pending);
        let mut sum = Tokens::default();
        for (_, _, tokens) in &pending {
            sum.add(*tokens);
        }
        // Interrupted turns can leave requests between snapshots. Only recover them when
        // their recorded usage explains the entire gap, preserving each model and tier.
        if !pending.is_empty()
            && cumulative
                .zip(previous)
                .and_then(|(now, old)| now.difference(old))
                == Some(sum)
        {
            for (model, tier, tokens) in pending {
                self.bill(&model, &tier, tokens);
            }
        } else {
            self.bill(&self.model.clone(), &self.tier.clone(), last);
        }
    }
    fn bill(&mut self, model: &str, tier: &str, tokens: Tokens) {
        let model = model_alias(model);
        self.totals.add(tokens);
        self.responses += 1;
        let speed = match tier {
            "" | "default" | "standard" => Some(1.0),
            // GPT-5.5 predates the uniform 2x Fast rate (LiteLLM's priority rate table).
            "fast" | "priority" if model == "gpt-5.5" => Some(2.5),
            "fast" | "priority" => Some(2.0),
            "ultrafast" => Some(6.0),
            "flex" | "batch" => Some(0.5),
            _ => None,
        };
        let Some(((mut input, mut output, mut cached), speed)) = rates(model).zip(speed) else {
            self.unpriced += tokens.input + tokens.output;
            return;
        };
        // API long-context rates; subscriptions may use different billing.
        if tokens.input > 272_000
            && (model.starts_with("gpt-6")
                || model.starts_with("gpt-5.6-")
                || model == "gpt-5.4"
                || model == "gpt-5.5")
        {
            input *= 2.0;
            cached *= 2.0;
            output *= 1.5;
        }
        // Cache writes use the public 30-minute rate. Reasoning is already in output.
        self.cost += speed
            * ((tokens.input - tokens.cached - tokens.written) as f64 * input
                + tokens.cached as f64 * cached
                + tokens.written as f64 * input * 1.25
                + tokens.output as f64 * output)
            / 1e6;
    }
    pub(super) fn summary(&self) -> Value {
        if self.responses == 0 {
            return Value::Null;
        }
        json!({
            "cost_usd": (self.cost * 10_000.0).round() / 10_000.0,
            "input_tokens": self.totals.input - self.totals.cached - self.totals.written,
            "cache_write_tokens": self.totals.written,
            "cache_read_tokens": self.totals.cached,
            "output_tokens": self.totals.output,
            "responses": self.responses,
            "unpriced_tokens": self.unpriced,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(model: &str) -> Value {
        json!({"type":"turn_context","payload":{"model":model}})
    }
    fn tokens(input: u64, cached: u64, output: u64) -> Value {
        json!({"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,
            "reasoning_output_tokens":output / 2,"total_tokens":input + output})
    }
    fn event(time: &str, last: Value, total: Value) -> Value {
        json!({"timestamp":time,"type":"event_msg","payload":{"type":"token_count",
            "info":{"last_token_usage":last,"total_token_usage":total}}})
    }
    fn tier(tier: &str) -> Value {
        json!({"type":"event_msg","payload":{"type":"thread_settings_applied",
            "thread_settings":{"service_tier":tier}}})
    }
    #[test]
    fn switchboard_codex_cost_prices_cache_and_reasoning_once_and_ignores_repeats() {
        let mut usage = Usage::default();
        assert_eq!(usage.summary(), Value::Null);
        usage.record(&context("gpt-6.1-sol"));
        let last = tokens(20_000, 12_000, 1000);
        let snapshot = event("2026-11-08T00:00:01Z", last.clone(), last);
        usage.record(&snapshot);
        usage.record(&snapshot);
        let mut repeat = snapshot.clone();
        repeat["timestamp"] = json!("2026-11-08T00:00:02Z");
        usage.record(&repeat);
        let summary = usage.summary();
        assert_eq!(summary["responses"], 1);
        assert_eq!(summary["cost_usd"], 0.0272);
        assert_eq!(summary["input_tokens"], 8000);
        assert_eq!(summary["output_tokens"], 1000);
    }
    #[test]
    fn switchboard_codex_cost_keeps_models_tiers_and_resumed_counters() {
        let mut usage = Usage::default();
        usage.record(&context("gpt-6.1-terra"));
        let last = tokens(10_000, 0, 1000);
        usage.record(&event("a", last.clone(), last.clone())); // .015
        usage.record(&context("gpt-6.1-sol"));
        usage.record(&tier("priority"));
        usage.record(&event("b", last.clone(), tokens(20_000, 0, 2000))); // .06
        usage.record(&tier("ultrafast"));
        usage.record(&event("c", last.clone(), last.clone())); // restart: .18
        usage.record(&context("gpt-future-unknown"));
        usage.record(&event("d", last, tokens(20_000, 0, 2000)));
        assert_eq!(usage.summary()["responses"], 4);
        assert_eq!(usage.summary()["cost_usd"], 0.255);
        assert_eq!(usage.summary()["unpriced_tokens"], 11_000);
    }
    #[test]
    fn switchboard_codex_cost_recovers_interrupted_requests_without_pricing_them_twice() {
        let mut usage = Usage::default();
        usage.record(&context("gpt-6.1-sol"));
        usage.record(&event("a", tokens(1000, 0, 100), tokens(1000, 0, 100)));
        for (model, input, output) in [("gpt-6.1-terra", 2000, 200), ("gpt-6.1-sol", 3000, 300)] {
            usage.record(&context(model));
            usage.record(
                &json!({"type":"token_usage_record","payload":{"usage":tokens(input, 0, output)}}),
            );
        }
        usage.record(&event("b", tokens(3000, 0, 300), tokens(6000, 0, 600)));
        assert_eq!(usage.summary()["responses"], 3);
        assert_eq!(usage.summary()["cost_usd"], 0.015);
    }
    #[test]
    fn switchboard_codex_cost_validates_usage_and_prices_long_context_and_cache_writes() {
        let mut usage = Usage::default();
        usage.record(&context("gpt-6.1-sol"));
        usage.record(&event("bad", tokens(10, 11, 1), Value::Null));
        assert_eq!(usage.summary(), Value::Null);
        let mut last = tokens(300_000, 100_000, 10_000);
        last["cache_write_input_tokens"] = json!(10_000);
        usage.record(&event("long", last.clone(), last));
        assert_eq!(usage.summary()["cost_usd"], 0.98);
        assert_eq!(model_alias("gpt-6.1-sol-2026-11-01"), "gpt-6.1-sol");
        assert_eq!(rates("gpt-6.1-sol-new"), None);
        assert_eq!(rates("unknown-😀😀😀😀"), None);
    }
    #[test]
    fn switchboard_codex_cost_prices_prefixed_snapshots_and_previous_generation_models() {
        for (model, expected) in [
            ("openai/gpt-6.1-sol", 1.35),
            ("gpt-5.4-2026-03-05", 1.725),
            ("gpt-5.6-sol", 2.7),
            ("gpt-5.6-terra", 1.38),
            ("gpt-5.6-luna", 0.138),
        ] {
            let mut usage = Usage::default();
            usage.bill(
                model,
                "default",
                Tokens {
                    input: 300_000,
                    output: 10_000,
                    ..Tokens::default()
                },
            );
            assert_eq!(usage.summary()["cost_usd"], expected, "{model}");
        }
        let mut usage = Usage::default();
        usage.bill(
            "gpt-5.5",
            "priority",
            Tokens {
                input: 10_000,
                output: 1000,
                ..Tokens::default()
            },
        );
        assert_eq!(usage.summary()["cost_usd"], 0.2);
    }
}
