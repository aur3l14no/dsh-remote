use crate::error::{Error, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}
impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.flag.load(Ordering::SeqCst) {
            Err(Error::new("CANCELLED", "operation cancelled before commit"))
        } else {
            Ok(())
        }
    }
    pub async fn cancelled(&self) {
        loop {
            let n = self.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            n.await;
        }
    }
}
