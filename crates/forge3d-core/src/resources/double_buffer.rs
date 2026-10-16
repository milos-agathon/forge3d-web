#[derive(Debug, Clone, PartialEq)]
pub struct DoubleBuffer<T> {
    front: T,
    back: T,
}

impl<T> DoubleBuffer<T> {
    pub fn new(front: T, back: T) -> Self {
        Self { front, back }
    }

    pub fn front(&self) -> &T {
        &self.front
    }

    pub fn back_mut(&mut self) -> &mut T {
        &mut self.back
    }

    pub fn swap(&mut self) {
        std::mem::swap(&mut self.front, &mut self.back);
    }
}
