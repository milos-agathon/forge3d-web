//! Replace named shader regions with strict cardinality and ordering.
//! Markers are WGSL comments, so the default world source remains valid.
pub(super) fn compose(template: &str, fragments: &[(&str, &str)]) -> Result<String, String> {
    let mut regions = Vec::new();
    for (name, body) in fragments {
        let begin = format!("// @compose-begin {name}\n");
        let end = format!("// @compose-end {name}");
        if template.matches(&begin).count() != 1 || template.matches(&end).count() != 1 {
            return Err(format!(
                "shader composition requires exactly one begin/end for {name}"
            ));
        }
        let start = template.find(&begin).unwrap();
        let finish = template.find(&end).unwrap();
        if finish < start + begin.len() {
            return Err(format!("reversed shader region {name}"));
        }
        regions.push((start, finish + end.len(), *body));
    }
    regions.sort_by_key(|r| r.0);
    let mut source = String::new();
    let mut cursor = 0;
    for (start, end, body) in regions {
        if start < cursor {
            return Err("overlapping or duplicate shader fragments".into());
        }
        source.push_str(&template[cursor..start]);
        source.push_str(body);
        cursor = end;
    }
    source.push_str(&template[cursor..]);
    Ok(source)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_duplicate_and_reversed_markers_fail_closed() {
        let source = "// @compose-begin a\ndefault\n// @compose-end a";
        assert_eq!(
            compose(source, &[("a", "replacement")]).unwrap(),
            "replacement"
        );
        assert!(compose(&source.replace("@compose-begin", "missing"), &[("a", "x")]).is_err());
        assert!(compose(&format!("{source}\n{source}"), &[("a", "x")]).is_err());
        assert!(compose("// @compose-end a\n// @compose-begin a\n", &[("a", "x")]).is_err());
        assert!(compose(source, &[("a", "x"), ("a", "y")]).is_err());
    }
}
