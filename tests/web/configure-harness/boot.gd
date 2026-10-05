extends Node

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	var js := Engine.get_singleton("JavaScriptBridge")
	if js == null:
		return
	var window = js.call("get_interface", "window")
	if window == null:
		return
	window.gdClerkReady = true
