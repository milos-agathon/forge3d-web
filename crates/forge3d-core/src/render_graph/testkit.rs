use super::{PassDescriptor, PassId, PassKind, ResourceDescriptor, ResourceId, ResourceKind};

pub(super) fn buffer(name: &str, size: u64) -> ResourceDescriptor {
    ResourceDescriptor {
        name: name.to_string(),
        kind: ResourceKind::Buffer { size },
        transient: false,
        aliasable: false,
    }
}

pub(super) fn transient_buffer(name: &str, size: u64) -> ResourceDescriptor {
    ResourceDescriptor {
        name: name.to_string(),
        kind: ResourceKind::Buffer { size },
        transient: true,
        aliasable: true,
    }
}

pub(super) fn transient_texture(
    name: &str,
    width: u32,
    height: u32,
    bytes_per_texel: u32,
) -> ResourceDescriptor {
    ResourceDescriptor {
        name: name.to_string(),
        kind: ResourceKind::Texture {
            width,
            height,
            depth_or_layers: 1,
            bytes_per_texel,
        },
        transient: true,
        aliasable: true,
    }
}

pub(super) fn pass(
    name: &str,
    reads: &[ResourceId],
    writes: &[ResourceId],
    depends_on: &[PassId],
) -> PassDescriptor {
    PassDescriptor {
        name: name.to_string(),
        kind: PassKind::Render,
        reads: reads.to_vec(),
        writes: writes.to_vec(),
        depends_on: depends_on.to_vec(),
    }
}
