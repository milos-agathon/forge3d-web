use forge3d_core::postfx::{Effect, EffectKind, PostFxConfig};
#[derive(Clone)]
pub(super) struct StagePlan {
    pub effect: String,
    pub label: String,
    pub lane: u32,
    pub parameters: [f32; 16],
    pub input: Option<usize>,
    pub auxiliary: Option<usize>,
    pub temporal: bool,
    pub lut: Option<forge3d_core::postfx::ColorLut>,
}
fn append(
    out: &mut Vec<StagePlan>,
    e: &Effect,
    part: &str,
    lane: u32,
    p: [f32; 16],
    input: Option<usize>,
    auxiliary: Option<usize>,
) -> usize {
    let index = out.len();
    out.push(StagePlan {
        effect: e.id.clone(),
        label: format!("{}:{part}", e.id),
        lane,
        parameters: p,
        input,
        auxiliary,
        temporal: matches!(lane, 7 | 16 | 17),
        lut: if lane == 19 { e.lut.clone() } else { None },
    });
    index
}
pub(super) fn stages(config: &PostFxConfig) -> Vec<StagePlan> {
    let mut out = Vec::new();
    let mut current = None;
    for e in config.effects.iter().filter(|e| e.enabled) {
        let mut p = e.params;
        let final_index = match e.kind {
            EffectKind::Ssao | EffectKind::Gtao | EffectKind::Ssgi | EffectKind::Ssr => {
                let original = current;
                let lane = match e.kind {
                    EffectKind::Ssao => 1,
                    EffectKind::Gtao => 2,
                    EffectKind::Ssgi => 3,
                    _ => 4,
                };
                let mut i = append(&mut out, e, "trace", lane, p, current, None);
                let radius = if lane <= 2 { p[4] } else { p[6] };
                let mut filter = [0.; 16];
                filter[0] = radius;
                filter[1] = 0.005;
                i = append(&mut out, e, "bilateral-x", 5, filter, Some(i), None);
                i = append(&mut out, e, "bilateral-y", 6, filter, Some(i), None);
                let mut t = [0.; 16];
                t[0] = p[5];
                i = append(&mut out, e, "temporal", 7, t, Some(i), None);
                append(
                    &mut out,
                    e,
                    "composite",
                    if lane <= 2 {
                        8
                    } else if lane == 4 {
                        21
                    } else {
                        9
                    },
                    p,
                    original,
                    Some(i),
                )
            }
            EffectKind::Bloom => {
                let original = current;
                let mut i = append(&mut out, e, "brightpass", 10, p, current, None);
                // Native nine-tap separable kernel at octave radii. Every tier
                // stays HDR; debug exposes the final blurred brightpass.
                for level in 0..p[4] as u32 {
                    let mut blur = [0.; 16];
                    blur[0] = p[3] * (1u32 << level) as f32;
                    i = append(
                        &mut out,
                        e,
                        &format!("blur-{level}-x"),
                        11,
                        blur,
                        Some(i),
                        None,
                    );
                    i = append(
                        &mut out,
                        e,
                        &format!("blur-{level}-y"),
                        12,
                        blur,
                        Some(i),
                        None,
                    );
                }
                append(&mut out, e, "composite", 13, p, original, Some(i))
            }
            EffectKind::Denoise => {
                let mut i = current;
                for step in 0..p[0] as u32 {
                    p[4] = (1u32 << step) as f32;
                    i = Some(append(
                        &mut out,
                        e,
                        &format!("atrous-{step}"),
                        18,
                        p,
                        i,
                        None,
                    ));
                }
                i.unwrap()
            }
            _ => append(
                &mut out,
                e,
                "resolve",
                match e.kind {
                    EffectKind::Dof => 14,
                    EffectKind::MotionBlur => 15,
                    EffectKind::Taa => 16,
                    EffectKind::AccumulationAa => 17,
                    EffectKind::Tonemap => 19,
                    EffectKind::Lens => 20,
                    _ => unreachable!(),
                },
                p,
                current,
                None,
            ),
        };
        current = Some(final_index);
    }
    out
}
