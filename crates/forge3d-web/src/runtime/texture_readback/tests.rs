use super::*;
use std::{
    future::Future,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};
struct Noop;
impl Wake for Noop {
    fn wake(self: Arc<Self>) {}
}
#[test]
fn rejected_mapping_and_cancelled_wait_release_admission() {
    let mut memory = MemoryLedger::new(1024, forge3d_core::memory::QualityLevel::High).unwrap();
    memory
        .replace("retained", MemoryCategory::Textures, 128)
        .unwrap();
    let waker = Waker::from(Arc::new(Noop));
    let mut cx = Context::from_waker(&waker);
    {
        let mut work = Box::pin(admitted(&mut memory, "test:readback", 768, async {
            Err::<(), _>(crate::error::WebError::new(
                crate::error::Forge3DErrorCode::IoError,
                "map rejected",
            ))
        }));
        assert!(matches!(work.as_mut().poll(&mut cx), Poll::Ready(Err(_))));
    }
    assert_eq!(memory.current_bytes(), 128);
    {
        let mut work = Box::pin(admitted(
            &mut memory,
            "test:readback",
            768,
            std::future::pending::<Result<(), WebError>>(),
        ));
        assert!(work.as_mut().poll(&mut cx).is_pending());
    }
    assert_eq!(memory.current_bytes(), 128);
    let polled = std::cell::Cell::new(false);
    {
        let mut work = Box::pin(admitted(&mut memory, "test:readback", 1024, async {
            polled.set(true);
            Ok(())
        }));
        assert!(matches!(work.as_mut().poll(&mut cx), Poll::Ready(Err(_))));
    }
    assert!(!polled.get());
    assert_eq!(memory.current_bytes(), 128);
}
#[test]
fn odd_rows_and_cube_layers_decode_in_order() {
    let layout = ReadbackFormat::R32Float.layout(3, 2).unwrap();
    let mut bytes = vec![0u8; layout.buffer_size as usize * 6];
    for layer in 0..6 {
        for row in 0..2 {
            for x in 0..3 {
                let offset = layer * layout.buffer_size as usize
                    + row * layout.padded_bytes_per_row as usize
                    + x * 4;
                bytes[offset..offset + 4]
                    .copy_from_slice(&((layer * 6 + row * 3 + x) as f32).to_le_bytes());
            }
        }
    }
    let data = Data {
        bytes,
        layout,
        format: ReadbackFormat::R32Float,
        layers: 6,
    };
    assert_eq!(
        data.floats().unwrap(),
        (0..36).map(|v| v as f32).collect::<Vec<_>>()
    );
    assert_eq!(data.tight().unwrap().len(), 36 * 4);
}
