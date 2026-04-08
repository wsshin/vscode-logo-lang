# *Logo* Interpreter & Debugger for VSCode

Standalone VSCode extension with interpreter and debugger for the Logo programming language.

## Features

- **Logo Language Support**: Implements the Logo interpreter directly in the extension
- **Code Suggestions**: Auto-completion for Logo commands and procedures
- **Live Preview**: Preview panel renders Logo graphics in real-time as you save your code.
- **Save images**: Right-click on the preview panel & select "Save as PNG".
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
- `PU` / `PENUP` - Lift pen
- `PD` / `PENDOWN` - Put pen down

### Drawing
- `CS` / `CLEARSCREEN` - Clear screen and reset turtle
- `CLEAR` - Clear the drawing without resetting turtle position
- `SETPENCOLOR` / `SETPC` - Set pen color
- `HIDETURTLE` / `HT` - Hide turtle cursor
- `SHOWTURTLE` / `ST` - Show turtle cursor
- `PU` / `PENUP` - Lift pen
- `PD` / `PENDOWN` - Put pen down

### Control Structures
- `REPEAT n [commands]` - Repeat commands n times
- `IF condition [commands]` - Conditional execution
- `IFELSE condition [true-commands] [false-commands]` - Conditional execution with two branches
- `LOAD "path.logo` / `LOAD :filename` - Load and execute another Logo file
- `TO name :param1 :param2 ... END` - Define procedures

### Variables and Expressions
- `:variable` - Variable reference
- `:var = expression` / `MAKE "var expression` - Variable assignment
- `RANDOM n` - Random integer in `[0, n)`, or `0` when `n <= 0`
- `INT expression` - Integer part of a number, truncated toward zero
- `REMAINDER a b` - Remainder using truncation toward zero, matching `a - INT(a / b) * b`
- Arithmetic operators: `+`, `-`, `*`, `/`
- Comparison operators: `=`, `<`, `>`
- Example: `MAKE "A (RANDOM 10)`, `PRINT INT (132 / 10)`, or `PRINT REMAINDER 132 10`

## Additional Commands
- `ARC` - Move along an arc
- `PRINT` / `PR` - Print a value to the output

## LOAD Notes
- Loaded files are read from disk and executed immediately.
- Procedures defined in loaded files become available to the current program.
- Relative paths are resolved from the file containing the `LOAD` command.
- Repeated `LOAD` commands re-execute the target file.
- In debugging, you can step into loaded files and set breakpoints in them.

## Usage

### Preview
1. Open a `.logo` file in VSCode
2. Press **Ctrl+Shift+V** or click the **preview** icon in the editor title bar
3. The preview panel will open, displaying the Logo graphics.
4. The preview automatically updates whenever you save the file.

### Debugging

1. Open a `.logo` file in VSCode
2. Press F5 or select "Debug Logo Program" from the debug menu
3. The graphics window will open automatically
4. Use standard debugging controls:
   - F10: Step over
   - F11: Step into
   - Shift+F11: Step out
   - F5: Continue
   - Shift+F5: Stop

## Examples

You can find example programs [here](https://github.com/zion-school/Logo-programs)
