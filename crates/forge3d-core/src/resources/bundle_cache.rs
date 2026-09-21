use std::collections::BTreeMap;

#[derive(Debug)]
pub struct RenderBundleCache<T> {
    bundles: BTreeMap<String, T>,
}

impl<T> RenderBundleCache<T> {
    pub fn new() -> Self {
        Self {
            bundles: BTreeMap::new(),
        }
    }

    pub fn insert(&mut self, key: impl Into<String>, bundle: T) -> Option<T> {
        self.bundles.insert(key.into(), bundle)
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.bundles.get(key)
    }

    pub fn remove(&mut self, key: &str) -> Option<T> {
        self.bundles.remove(key)
    }

    pub fn clear(&mut self) {
        self.bundles.clear();
    }

    pub fn len(&self) -> usize {
        self.bundles.len()
    }
}

impl<T> Default for RenderBundleCache<T> {
    fn default() -> Self {
        Self::new()
    }
}
