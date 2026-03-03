# *Logo* Interpreter & Debugger for VSCode

Standalone VSCode extension with interpreter and debugger for the Logo programming language.

## Features

- **Logo Language Support**: Implements the Logo interpreter directly in the extension
- **Code Suggestions**: Auto-completion for Logo commands and procedures
- **Debugging**: Set breakpoints, step through code, inspect variables
- **Syntax Highlighting**: Logo language syntax highlighting
- **Syntax Checking**: Basic syntax error detection
- **Variable Inspection**: View turtle state (position, angle, pen status) and program variables

## Supported Logo Commands

### Turtle Movement
- `FD` / `FORWARD` - Move forward
- `BK` / `BACK` / `BACKWARD` - Move backward
- `RT` / `RIGHT` - Turn right
- `LT` / `LEFT` - Turn left
- `ARC` - Move along an arc
- `PU` / `PENUP` - Lift pen
- `PD` / `PENDOWN` - Put pen down

### Drawing
- `CS` / `CLEARSCREEN` - Clear screen and reset turtle
- `SETPENCOLOR` / `SETPC` - Set pen color

### Control Structures
- `REPEAT n [commands]` - Repeat commands n times
- `IF condition [commands]` - Conditional execution
- `TO name :param1 :param2 ... END` - Define procedures

### Variables and Expressions
- `:variable` - Variable reference
- `:var = expression` / `MAKE "var expression` - Variable assignment
- Arithmetic operators: `+`, `-`, `*`, `/`
- Comparison operators: `=`, `<`, `>`

## Usage

1. Open a `.logo` file in VSCode
2. Press F5 or select "Debug Logo Program" from the debug menu
3. The SVG graphics window will open automatically
4. Use standard debugging controls:
   - F10: Step over
   - F11: Step into
   - Shift+F11: Step out
   - F5: Continue
   - Shift+F5: Stop

