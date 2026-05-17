package tools

// RegisterAll wires every builtin tool. Callers may follow up with their own
// reg.Register calls for project-specific tools.
func RegisterAll(reg *Registry, deps Deps, sshReadonlyAllow []string) {
	RegisterNodeTools(reg, deps)
	RegisterSSHTools(reg, deps, sshReadonlyAllow)
	RegisterSFTPTools(reg, deps)
	RegisterSessionTools(reg, deps)
	RegisterSubAgentTool(reg, deps)
}
