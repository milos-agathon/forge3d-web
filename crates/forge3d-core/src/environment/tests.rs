#[cfg(test)]
mod tests {
    use super::super::*;
    #[test]
    fn native_sun_contract() {
        for (lat, lon, y, m, d, h, az, el) in [
            (51.5, 0., 2024, 6, 21, 12, 179., 62.),
            (51.5, 0., 2024, 12, 21, 12, 180., 15.),
        ] {
            let s = sun::sun_position(lat, lon, y, m, d, h, 0, 0);
            assert!((s.azimuth - az).abs() < 2.0);
            assert!((s.elevation - el).abs() < 1.0);
            assert!((glam::Vec3::from(s.to_direction()).length() - 1.0).abs() < 1e-6);
        }
        assert!(sun::sun_position(69.65, 18.96, 2024, 6, 21, 0, 0, 0).elevation > 0.0);
        assert!(sun::sun_position(69.65, 18.96, 2024, 12, 21, 12, 0, 0).elevation < 0.0);
    }
    #[test]
    fn bounded_volume() {
        assert_eq!(
            ray_box(
                glam::vec3(2., 0., 0.),
                glam::Vec3::Y,
                [-1., -1., -1., 1., 1., 1.]
            ),
            None
        );
        assert_eq!(
            ray_box(
                glam::vec3(0., 0., -3.),
                glam::Vec3::Z,
                [-1., -1., -1., 1., 1., 1.]
            ),
            Some((2., 4.))
        );
        assert!((hg(0.2, 0.) - 1.0 / (4.0 * std::f32::consts::PI)).abs() < 1e-7);
    }
}
