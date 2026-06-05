use crate::error::Result;
use crate::gpu::GpuContext;

#[derive(Debug, Clone)]
pub struct SurfaceStateDescriptor {
    pub width: u32,
    pub height: u32,
    pub format: wgpu::TextureFormat,
    pub present_mode: wgpu::PresentMode,
    pub alpha_mode: wgpu::CompositeAlphaMode,
    pub view_formats: Vec<wgpu::TextureFormat>,
}

impl SurfaceStateDescriptor {
    pub fn new(width: u32, height: u32, format: wgpu::TextureFormat) -> Self {
        Self {
            width,
            height,
            format,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: Vec::new(),
        }
    }
}

pub struct SurfaceState {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
}

impl SurfaceState {
    pub fn new(
        surface: wgpu::Surface<'static>,
        context: &GpuContext,
        descriptor: SurfaceStateDescriptor,
    ) -> Result<Self> {
        let config = surface_configuration(&context.adapter, descriptor)?;
        surface.configure(&context.device, &config);
        Ok(Self { surface, config })
    }

    pub fn configure(&self, context: &GpuContext) {
        self.surface.configure(&context.device, &self.config);
    }

    pub fn resize(&mut self, context: &GpuContext, width: u32, height: u32) -> Result<()> {
        validate_surface_size(width, height)?;
        self.config.width = width;
        self.config.height = height;
        self.configure(context);
        Ok(())
    }
}

pub fn surface_configuration(
    adapter: &wgpu::Adapter,
    descriptor: SurfaceStateDescriptor,
) -> Result<wgpu::SurfaceConfiguration> {
    validate_surface_size(descriptor.width, descriptor.height)?;

    Ok(wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format: descriptor.format,
        width: descriptor.width,
        height: descriptor.height,
        present_mode: descriptor.present_mode,
        alpha_mode: descriptor.alpha_mode,
        view_formats: descriptor.view_formats,
        desired_maximum_frame_latency: desired_maximum_frame_latency(adapter),
    })
}

fn validate_surface_size(width: u32, height: u32) -> Result<()> {
    if width == 0 {
        return Err(crate::error::Forge3dError::InvalidInput {
            field: "width".to_string(),
            message: "surface width must be greater than zero".to_string(),
        });
    }

    if height == 0 {
        return Err(crate::error::Forge3dError::InvalidInput {
            field: "height".to_string(),
            message: "surface height must be greater than zero".to_string(),
        });
    }

    Ok(())
}

fn desired_maximum_frame_latency(_adapter: &wgpu::Adapter) -> u32 {
    2
}

#[cfg(test)]
mod tests {
    use super::SurfaceStateDescriptor;

    #[test]
    fn surface_descriptor_defaults_to_fifo_presentation() {
        let descriptor = SurfaceStateDescriptor::new(640, 480, wgpu::TextureFormat::Rgba8UnormSrgb);

        assert_eq!(descriptor.width, 640);
        assert_eq!(descriptor.height, 480);
        assert_eq!(descriptor.format, wgpu::TextureFormat::Rgba8UnormSrgb);
        assert_eq!(descriptor.present_mode, wgpu::PresentMode::Fifo);
        assert_eq!(descriptor.alpha_mode, wgpu::CompositeAlphaMode::Auto);
        assert!(descriptor.view_formats.is_empty());
    }

    #[test]
    fn surface_configuration_rejects_zero_size_before_touching_adapter() {
        let descriptor = SurfaceStateDescriptor::new(0, 480, wgpu::TextureFormat::Rgba8UnormSrgb);

        let error = super::validate_surface_size(descriptor.width, descriptor.height).unwrap_err();

        assert!(error.to_string().contains("width"));
    }
}
