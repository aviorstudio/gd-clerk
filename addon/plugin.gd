@tool
extends EditorPlugin

const AUTOLOAD_NAME := "GdClerk"
const AUTOLOAD_SCRIPT := preload("gd_clerk.gd")

var _export_plugin: EditorExportPlugin

func _enter_tree() -> void:
	var source: Script = AUTOLOAD_SCRIPT
	add_autoload_singleton(AUTOLOAD_NAME, source.resource_path)
	_export_plugin = preload("export_plugin.gd").new()
	add_export_plugin(_export_plugin)

func _exit_tree() -> void:
	if _export_plugin != null:
		remove_export_plugin(_export_plugin)
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD_NAME):
		remove_autoload_singleton(AUTOLOAD_NAME)
