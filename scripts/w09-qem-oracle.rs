#[derive(Clone, Default)]
pub struct MeshBuffers {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub tangents: Vec<[f32; 4]>,
    pub indices: Vec<u32>,
}

impl MeshBuffers {
    pub fn with_capacity(vertex_capacity: usize, index_capacity: usize) -> Self {
        Self {
            positions: Vec::with_capacity(vertex_capacity),
            normals: Vec::with_capacity(vertex_capacity),
            uvs: Vec::with_capacity(vertex_capacity),
            tangents: Vec::with_capacity(vertex_capacity),
            indices: Vec::with_capacity(index_capacity),
        }
    }
}

#[derive(Debug)]
pub struct GeometryError {
    message: String,
}

impl GeometryError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub type GeometryResult<T> = Result<T, GeometryError>;

mod historical {
    // The included source has Git blob
    // 839e05c1d903676e184c4a910e0a943286c923ac, identical at 1f4084a and bf8db93.
    include!("simplify.rs");
}

fn source_mesh() -> MeshBuffers {
    let width = 6usize;
    let height = 5usize;
    let mut mesh = MeshBuffers::default();
    for z in 0..height {
        for x in 0..width {
            let y = ((x * x * 3 + z * 7 + x * z * 5) % 17) as f32 / 11.0;
            mesh.positions.push([x as f32 / 3.0, y, z as f32 / 4.0]);
            mesh.normals.push([0.0; 3]);
        }
    }
    for z in 0..height - 1 {
        for x in 0..width - 1 {
            let a = (z * width + x) as u32;
            let b = a + 1;
            let c = a + width as u32;
            let d = c + 1;
            mesh.indices.extend_from_slice(&[a, c, b, b, c, d]);
        }
    }
    mesh
}

fn print_f32(values: impl Iterator<Item = f32>) {
    print!("[");
    let mut first = true;
    for value in values {
        if !first { print!(","); }
        first = false;
        print!("{value:?}");
    }
    print!("]");
}

fn print_u32(values: impl Iterator<Item = u32>) {
    print!("[");
    let mut first = true;
    for value in values {
        if !first { print!(","); }
        first = false;
        print!("{value}");
    }
    print!("]");
}

fn main() {
    let mesh = source_mesh();
    print!("[");
    for (case_index, ratio) in [0.73f32, 0.41f32].into_iter().enumerate() {
        if case_index > 0 { print!(","); }
        let simplified = historical::simplify_mesh(&mesh, ratio).expect("historical simplify succeeds");
        print!("{{\"ratio\":{ratio:?},\"positions\":");
        print_f32(simplified.positions.iter().flat_map(|point| point.iter().copied()));
        print!(",\"normals\":");
        print_f32(simplified.normals.iter().flat_map(|normal| normal.iter().copied()));
        print!(",\"indices\":");
        print_u32(simplified.indices.into_iter());
        print!("}}");
    }
    println!("]");
}
