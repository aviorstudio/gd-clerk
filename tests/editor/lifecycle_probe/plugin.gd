@tool
extends EditorPlugin

const TARGET := "res://addons/@aviorstudio_gd-clerk/plugin.cfg"

func _enter_tree() -> void:
	call_deferred("_observe")

func _observe() -> void:
	var phase := FileAccess.get_file_as_string("res://lifecycle_phase.txt").strip_edges()
	var enabled := EditorInterface.is_plugin_enabled(TARGET)
	var autoload := str(ProjectSettings.get_setting("autoload/GdClerk", ""))
	var has := ProjectSettings.has_setting("autoload/GdClerk")
	if phase == "disable":
		if not enabled or not has or autoload == "":
			_fail("disable-before enabled=%s has=%s autoload=%s" % [enabled, has, autoload])
			return
		EditorInterface.set_plugin_enabled(TARGET, false)
		call_deferred("_after_disable")
		return
	if phase != "enable" and phase != "restart":
		_fail("unknown phase " + phase)
		return
	if not enabled or not has or autoload == "":
		_fail("phase=%s enabled=%s has=%s autoload=%s" % [phase, enabled, has, autoload])
		return
	if not (autoload.contains("gd_clerk.gd") or autoload.contains("uid://")):
		_fail("autoload does not reference installed script: " + autoload)
		return
	_ok("phase=%s enabled=true autoload=%s" % [phase, autoload])

func _after_disable() -> void:
	var enabled := EditorInterface.is_plugin_enabled(TARGET)
	var has := ProjectSettings.has_setting("autoload/GdClerk")
	if enabled or has:
		_fail("disable-after enabled=%s has=%s" % [enabled, has])
		return
	_ok("phase=disable enabled=false")

func _ok(line: String) -> void:
	_write("ok " + line)
	get_tree().quit(0)

func _fail(line: String) -> void:
	_write("fail " + line)
	push_error("LIFECYCLE " + line)
	get_tree().quit(1)

func _write(line: String) -> void:
	print("LIFECYCLE " + line)
	var out := FileAccess.open("res://lifecycle_result.txt", FileAccess.WRITE)
	if out:
		out.store_string(line + "\n")
		out.close()
