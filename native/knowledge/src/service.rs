//! The method table.
//!
//! Every method is a fixed name in this match — nothing is dispatched
//! dynamically and no raw SQL crosses the pipe. The data root is bound once at
//! startup and the databases open on the first data method, so a status query
//! or an application that never uses the feature touches no directory, no
//! database and no child process.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use serde::Deserialize;

use crate::protocol::{ApiError, ApiResult, Code};
use crate::store::{KNOWLEDGE_SCHEMA, PROFILE_SCHEMA, Store};
use crate::util::ensure_not_cancelled;
use crate::{cards, profile, sources};

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct InvalidateParams {
    id: String,
    #[serde(default)]
    reason: Option<String>,
}

pub struct Outcome {
    pub result: Value,
    pub scope: Option<&'static str>,
    pub shutdown: bool,
}

fn changed(result: Value, scope: &'static str) -> Outcome {
    Outcome {
        result,
        scope: Some(scope),
        shutdown: false,
    }
}

pub struct Service {
    root: PathBuf,
    store: Mutex<Option<Arc<Store>>>,
    fts5: bool,
    trigram: bool,
}

fn decode<T: DeserializeOwned>(params: Value) -> ApiResult<T> {
    serde_json::from_value(params)
        .map_err(|error| ApiError::invalid(format!("invalid params: {error}")))
}

impl Service {
    pub fn new(root: PathBuf, fts5: bool, trigram: bool) -> Arc<Service> {
        Arc::new(Service {
            root,
            store: Mutex::new(None),
            fts5,
            trigram,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Opens both databases on first use. Nothing calls this at startup.
    pub fn store(&self) -> ApiResult<Arc<Store>> {
        let mut slot = self
            .store
            .lock()
            .map_err(|_| ApiError::new(Code::Internal, "the store lock was poisoned"))?;
        if let Some(store) = slot.as_ref() {
            return Ok(store.clone());
        }
        let store = Arc::new(Store::open(&self.root)?);
        *slot = Some(store.clone());
        Ok(store)
    }

    pub fn is_open(&self) -> bool {
        self.store
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false)
    }

    pub fn dispatch(&self, method: &str, params: Value) -> ApiResult<Outcome> {
        ensure_not_cancelled()?;
        match method {
            "status" => Ok(Outcome {
                result: json!({
                    "version": crate::protocol::VERSION,
                    "schema": { "knowledge": KNOWLEDGE_SCHEMA, "profile": PROFILE_SCHEMA },
                    "opened": self.is_open(),
                    "fts5": self.fts5,
                    "trigram": self.trigram,
                }),
                scope: None,
                shutdown: false,
            }),
            "shutdown" => Ok(Outcome {
                result: json!({ "ok": true }),
                scope: None,
                shutdown: true,
            }),
            "source.save" => {
                let store = self.store()?;
                let mut connection = store.knowledge.lock().map_err(lock_error)?;
                let source = sources::save(&mut connection, decode(params)?)?;
                Ok(changed(
                    serde_json::to_value(source).map_err(encode_error)?,
                    "sources",
                ))
            }
            "source.get" => {
                let store = self.store()?;
                let connection = store.knowledge.lock().map_err(lock_error)?;
                let params: IdParams = decode(params)?;
                let source = sources::get(&connection, &params.id)?;
                Ok(Outcome {
                    result: serde_json::to_value(source).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            "source.invalidate" => {
                let store = self.store()?;
                let mut connection = store.knowledge.lock().map_err(lock_error)?;
                let params: InvalidateParams = decode(params)?;
                let source =
                    sources::invalidate(&mut connection, &params.id, params.reason.as_deref())?;
                Ok(changed(
                    serde_json::to_value(source).map_err(encode_error)?,
                    "sources",
                ))
            }
            "card.save" => {
                let store = self.store()?;
                let mut connection = store.knowledge.lock().map_err(lock_error)?;
                let card = cards::save(&mut connection, decode(params)?)?;
                Ok(changed(
                    serde_json::to_value(card).map_err(encode_error)?,
                    "cards",
                ))
            }
            "card.update" => {
                let store = self.store()?;
                let mut connection = store.knowledge.lock().map_err(lock_error)?;
                let card = cards::update(&mut connection, decode(params)?)?;
                Ok(changed(
                    serde_json::to_value(card).map_err(encode_error)?,
                    "cards",
                ))
            }
            "card.delete" => {
                let store = self.store()?;
                let mut connection = store.knowledge.lock().map_err(lock_error)?;
                let params: IdParams = decode(params)?;
                let removed = cards::delete(&mut connection, &params.id)?;
                Ok(changed(json!({ "removed": removed }), "cards"))
            }
            "card.get" => {
                let store = self.store()?;
                let connection = store.knowledge.lock().map_err(lock_error)?;
                let params: IdParams = decode(params)?;
                let card = cards::get(&connection, &params.id)?;
                Ok(Outcome {
                    result: serde_json::to_value(card).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            "card.list" => {
                let store = self.store()?;
                let connection = store.knowledge.lock().map_err(lock_error)?;
                let page = cards::list(&connection, decode(params)?)?;
                Ok(Outcome {
                    result: serde_json::to_value(page).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            "card.search" => {
                let store = self.store()?;
                let connection = store.knowledge.lock().map_err(lock_error)?;
                let page = cards::search(&connection, decode(params)?)?;
                Ok(Outcome {
                    result: serde_json::to_value(page).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            "profile.save" => {
                let store = self.store()?;
                let mut connection = store.profile.lock().map_err(lock_error)?;
                let item = profile::save(&mut connection, decode(params)?)?;
                Ok(changed(
                    serde_json::to_value(item).map_err(encode_error)?,
                    "profile",
                ))
            }
            "profile.update" => {
                let store = self.store()?;
                let mut connection = store.profile.lock().map_err(lock_error)?;
                let item = profile::update(&mut connection, decode(params)?)?;
                Ok(changed(
                    serde_json::to_value(item).map_err(encode_error)?,
                    "profile",
                ))
            }
            "profile.delete" => {
                let store = self.store()?;
                let mut connection = store.profile.lock().map_err(lock_error)?;
                let params: IdParams = decode(params)?;
                let removed = profile::delete(&mut connection, &params.id)?;
                Ok(changed(json!({ "removed": removed }), "profile"))
            }
            "profile.get" => {
                let store = self.store()?;
                let connection = store.profile.lock().map_err(lock_error)?;
                let params: IdParams = decode(params)?;
                let item = profile::get(&connection, &params.id)?;
                Ok(Outcome {
                    result: serde_json::to_value(item).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            "profile.list" => {
                let store = self.store()?;
                let connection = store.profile.lock().map_err(lock_error)?;
                let page = profile::list(&connection, decode(params)?)?;
                Ok(Outcome {
                    result: serde_json::to_value(page).map_err(encode_error)?,
                    scope: None,
                    shutdown: false,
                })
            }
            other => Err(ApiError::new(
                Code::UnknownMethod,
                format!("unknown method: {other}"),
            )),
        }
    }
}

fn lock_error<T>(_: T) -> ApiError {
    ApiError::new(Code::Internal, "a database lock was poisoned")
}

fn encode_error(error: serde_json::Error) -> ApiError {
    ApiError::new(Code::Internal, format!("cannot encode the result: {error}"))
}
