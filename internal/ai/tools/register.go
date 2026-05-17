package tools

// RegisterAll wires every builtin tool. Callers may follow up with their own
// reg.Register calls for project-specific tools.
//
// sshReadonlyAllow REPLACES the default allow list when non-empty.
// sshReadonlyExtra is APPENDED to the resolved base (default or override).
func RegisterAll(reg *Registry, deps Deps, sshReadonlyAllow []string, sshReadonlyExtra ...[]string) {
	RegisterNodeTools(reg, deps)
	RegisterSSHTools(reg, deps, sshReadonlyAllow, sshReadonlyExtra...)
	RegisterSFTPTools(reg, deps)
	RegisterSessionTools(reg, deps)
	RegisterIdentityTools(reg, deps)
	RegisterSubAgentTool(reg, deps)
}
