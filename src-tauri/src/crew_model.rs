// Shared crews: the crew file kept in the company SharePoint folder, and the
// rules for changing it. Only admins change a crew; anyone with the code can
// view it. Kept free of Edge and Tauri so the rules can be unit-tested.

use serde::{Deserialize, Serialize};

pub const ADMIN: &str = "admin";
pub const MEMBER: &str = "member";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// Report name, "Surname, Name"
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    /// "admin" or "member"
    pub role: String,
    #[serde(default)]
    pub added_by: Option<String>,
    #[serde(default)]
    pub added_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crew {
    /// Six-character code, also the file name: crew-<id>.json
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub members: Vec<Member>,
}

/// Who is making a change.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// Someone to add.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMember {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CrewChange {
    AddMembers { members: Vec<NewMember> },
    RemoveMember { name: String },
    SetRole { name: String, role: String },
    Rename { name: String },
    Delete,
}

/// The crew file name for a code.
pub fn file_name(id: &str) -> String {
    format!("crew-{}.json", id)
}

const CODE_CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// A new six-character crew code (no 0/O or 1/I, so it is easy to type).
pub fn new_code(mut seed: u64) -> String {
    (0..6)
        .map(|_| {
            let c = CODE_CHARS[(seed % CODE_CHARS.len() as u64) as usize] as char;
            seed /= CODE_CHARS.len() as u64;
            c
        })
        .collect()
}

/// A crew code typed or pasted in any form ("7kq4m2", "Code: 7KQ4M2").
pub fn parse_code(text: &str) -> Option<String> {
    let upper = text.to_uppercase();
    upper
        .split(|c: char| !c.is_ascii_alphanumeric())
        .find(|w| w.len() == 6 && w.bytes().all(|b| CODE_CHARS.contains(&b)) && w.bytes().any(|b| b.is_ascii_digit()))
        .or_else(|| upper.split(|c: char| !c.is_ascii_alphanumeric()).find(|w| w.len() == 6 && w.bytes().all(|b| CODE_CHARS.contains(&b))))
        .map(str::to_string)
}

fn same_person(m: &Member, name: &str, email: Option<&str>) -> bool {
    match (m.email.as_deref(), email) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a.eq_ignore_ascii_case(b),
        _ => m.name.eq_ignore_ascii_case(name),
    }
}

pub fn find_member<'a>(crew: &'a Crew, name: &str, email: Option<&str>) -> Option<&'a Member> {
    crew.members.iter().find(|m| same_person(m, name, email))
}

pub fn is_admin(crew: &Crew, actor: &Actor) -> bool {
    find_member(crew, &actor.name, actor.email.as_deref()).is_some_and(|m| m.role == ADMIN)
}

fn admins(crew: &Crew) -> usize {
    crew.members.iter().filter(|m| m.role == ADMIN).count()
}

/// A new crew with the creator as its admin, plus any starting members.
pub fn new_crew(id: &str, name: &str, creator: &Actor, members: &[NewMember], now: &str) -> Result<Crew, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the crew a name.".to_string());
    }
    let mut crew = Crew {
        id: id.to_string(),
        name: name.chars().take(60).collect(),
        created_by: creator.email.clone().or_else(|| Some(creator.name.clone())),
        created_at: Some(now.to_string()),
        updated_by: None,
        updated_at: None,
        members: vec![Member {
            name: creator.name.clone(),
            email: creator.email.clone(),
            role: ADMIN.to_string(),
            added_by: None,
            added_at: Some(now.to_string()),
        }],
    };
    add_members(&mut crew, members, creator, now);
    Ok(crew)
}

fn add_members(crew: &mut Crew, members: &[NewMember], by: &Actor, now: &str) {
    for m in members {
        let email = m.email.as_deref().map(str::trim).filter(|e| !e.is_empty());
        if m.name.trim().is_empty() || find_member(crew, &m.name, email).is_some() {
            continue;
        }
        crew.members.push(Member {
            name: m.name.trim().to_string(),
            email: email.map(str::to_lowercase),
            role: MEMBER.to_string(),
            added_by: by.email.clone().or_else(|| Some(by.name.clone())),
            added_at: Some(now.to_string()),
        });
    }
}

/// Applies a change made by `actor`. Returns the updated crew, or None when
/// the crew is deleted. Only admins may change a crew, and a crew always
/// keeps at least one admin.
pub fn apply_change(mut crew: Crew, change: &CrewChange, actor: &Actor, now: &str) -> Result<Option<Crew>, String> {
    if !is_admin(&crew, actor) {
        return Err("Only an admin of this crew can change it.".to_string());
    }
    match change {
        CrewChange::AddMembers { members } => add_members(&mut crew, members, actor, now),
        CrewChange::RemoveMember { name } => {
            let i = crew.members.iter().position(|m| m.name.eq_ignore_ascii_case(name)).ok_or("That person is not in this crew.")?;
            if crew.members[i].role == ADMIN && admins(&crew) == 1 {
                return Err("A crew needs at least one admin. Make someone else admin first.".to_string());
            }
            crew.members.remove(i);
        }
        CrewChange::SetRole { name, role } => {
            if role != ADMIN && role != MEMBER {
                return Err(format!("Unknown role \"{}\".", role));
            }
            let lone_admin = admins(&crew) == 1;
            let m = crew.members.iter_mut().find(|m| m.name.eq_ignore_ascii_case(name)).ok_or("That person is not in this crew.")?;
            if m.role == ADMIN && role == MEMBER && lone_admin {
                return Err("A crew needs at least one admin. Make someone else admin first.".to_string());
            }
            m.role = role.clone();
        }
        CrewChange::Rename { name } => {
            let name = name.trim();
            if name.is_empty() {
                return Err("Give the crew a name.".to_string());
            }
            crew.name = name.chars().take(60).collect();
        }
        CrewChange::Delete => return Ok(None),
    }
    crew.updated_by = actor.email.clone().or_else(|| Some(actor.name.clone()));
    crew.updated_at = Some(now.to_string());
    Ok(Some(crew))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Actor {
        Actor { name: "Combrink, Sybrandt".into(), email: Some("sybrandt.combrink@hatch.com".into()) }
    }
    fn willem() -> Actor {
        Actor { name: "du Plooy, Willem".into(), email: Some("willem.duplooy@hatch.com".into()) }
    }
    fn nm(name: &str, email: Option<&str>) -> NewMember {
        NewMember { name: name.into(), email: email.map(Into::into) }
    }

    #[test]
    fn creator_is_admin_and_duplicates_are_skipped() {
        let c = new_crew("7KQ4M2", "  Cape Town Mech ", &me(), &[nm("du Plooy, Willem", Some("Willem.duPlooy@hatch.com")), nm("Combrink, Sybrandt", None)], "t").unwrap();
        assert_eq!(c.name, "Cape Town Mech");
        assert_eq!(c.members.len(), 2);
        assert_eq!(c.members[0].role, ADMIN);
        assert_eq!(c.members[1].role, MEMBER);
        assert_eq!(c.members[1].email.as_deref(), Some("willem.duplooy@hatch.com"));
        assert!(new_crew("X", " ", &me(), &[], "t").is_err());
    }

    #[test]
    fn only_admins_change_and_one_admin_remains() {
        let c = new_crew("7KQ4M2", "Crew", &me(), &[nm("du Plooy, Willem", Some("willem.duplooy@hatch.com"))], "t").unwrap();
        // A member cannot change anything.
        assert!(apply_change(c.clone(), &CrewChange::Rename { name: "Mine".into() }, &willem(), "t").is_err());
        // The only admin cannot step down or leave.
        assert!(apply_change(c.clone(), &CrewChange::SetRole { name: "Combrink, Sybrandt".into(), role: MEMBER.into() }, &me(), "t").is_err());
        assert!(apply_change(c.clone(), &CrewChange::RemoveMember { name: "Combrink, Sybrandt".into() }, &me(), "t").is_err());
        // Promote Willem; then either can step down.
        let c = apply_change(c, &CrewChange::SetRole { name: "du Plooy, Willem".into(), role: ADMIN.into() }, &me(), "t2").unwrap().unwrap();
        assert!(is_admin(&c, &willem()));
        assert_eq!(c.updated_at.as_deref(), Some("t2"));
        let c = apply_change(c, &CrewChange::RemoveMember { name: "Combrink, Sybrandt".into() }, &willem(), "t3").unwrap().unwrap();
        assert_eq!(c.members.len(), 1);
        assert!(apply_change(c, &CrewChange::Delete, &willem(), "t4").unwrap().is_none());
    }

    #[test]
    fn matches_by_email_then_name() {
        let c = new_crew("7KQ4M2", "Crew", &me(), &[], "t").unwrap();
        // Same email, report name spelled differently: still the admin.
        assert!(is_admin(&c, &Actor { name: "Combrink, S".into(), email: Some("SYBRANDT.COMBRINK@hatch.com".into()) }));
        // No email: by name.
        assert!(is_admin(&c, &Actor { name: "combrink, sybrandt".into(), email: None }));
        assert!(!is_admin(&c, &willem()));
    }

    #[test]
    fn codes() {
        let a = new_code(123456789);
        assert_eq!(a.len(), 6);
        assert!(a.bytes().all(|b| CODE_CHARS.contains(&b)));
        assert_ne!(a, new_code(987654321));
        assert_eq!(parse_code("7kq4m2").as_deref(), Some("7KQ4M2"));
        assert_eq!(parse_code("Join my crew, code: 7KQ4M2 (Cape Town)").as_deref(), Some("7KQ4M2"));
        assert_eq!(file_name("7KQ4M2"), "crew-7KQ4M2.json");
        assert!(parse_code("hello").is_none());
    }
}
